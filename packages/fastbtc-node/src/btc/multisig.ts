import {inject, injectable} from 'inversify';
import {bip32, ECPair, Network, networks, Payment, payments, Psbt} from "bitcoinjs-lib";
import {normalizeKey, xprvToPublic} from './utils';
import getByteCount from './bytecount';
import BitcoinNodeWrapper, {IBitcoinNodeWrapper} from './nodewrapper';
import {BigNumber} from 'ethers';
import {Config} from '../config';
import {pbkdf2} from 'crypto';


export interface PartiallySignedBitcoinTransaction {
    serializedTransaction: string;
    signedPublicKeys: string[];
    requiredSignatures: number;
}

export interface BtcTransfer {
    btcAddress: string;
    amountSatoshi: BigNumber;
    nonce: number;
}

export type BitcoinMultisigConfig = Pick<Config,
    'btcRpcUrl' | 'btcRpcUsername' | 'btcRpcPassword' | 'btcNetwork' | 'btcMasterPrivateKey' | 'btcMasterPublicKeys' | 'btcKeyDerivationPath'>

@injectable()
export class BitcoinMultisig {
    private readonly network: Network;
    private gasSatoshi = 10; // TODO: make variable/configurable
    private cosigners = 2; // TODO: make configurable
    private nodeWrapper: IBitcoinNodeWrapper;
    private readonly masterPrivateKey: string;
    private readonly masterPublicKey: string;
    private masterPublicKeys: string[];
    private readonly keyDerivationPath: string;
    private readonly maximumBatchSize = 40;
    public readonly payoutScript: Payment;

    constructor(
        @inject(Config) config: BitcoinMultisigConfig,
        @inject(BitcoinNodeWrapper) nodeWrapper: IBitcoinNodeWrapper,
    ) {
        this.network = nodeWrapper.network;

        this.nodeWrapper = nodeWrapper;

        this.masterPrivateKey = normalizeKey(config.btcMasterPrivateKey);
        this.masterPublicKey = xprvToPublic(this.masterPrivateKey, this.network);
        this.masterPublicKeys = config.btcMasterPublicKeys;

        this.keyDerivationPath = config.btcKeyDerivationPath || '0/0/0';

        let childPublic: Buffer[] = this.deriveChildPublicKeys(this.keyDerivationPath);
        this.payoutScript = payments.p2wsh({
            network: this.network,
            redeem: payments.p2ms({
                m: this.cosigners,
                pubkeys: childPublic,
                network: this.network,
            }),
        });

    }

    deriveChildPublicKeys(path: string): Buffer[] {
        const childPublic: Buffer[] = this.masterPublicKeys.map((pubKey) =>
            bip32.fromBase58(pubKey, this.network).derivePath(this.keyDerivationPath).publicKey,
        );
        childPublic.sort((a, b) => {
            return a.toString('hex') < b.toString('hex') ? -1 : 1;
        });
        return childPublic;
    }

    async createPartiallySignedTransaction(transfers: BtcTransfer[]): Promise<PartiallySignedBitcoinTransaction> {
        if (transfers.length > this.maximumBatchSize) {
            throw new Error(`The number of transfers ${transfers.length} exceeds the maximum batch size ${this.maximumBatchSize}`);
        }

        const network = this.network;
        const inputType = `MULTISIG-P2WSH:${this.cosigners}-${this.masterPublicKeys.length}`;
        const payment = this.payoutScript;

        const response = await this.nodeWrapper.call("listunspent",
            [1, 9999999, [payment.address]],  // !!!
        );

        response.sort((a: any, b: any) => {
            if (a.confirmations > b.confirmations) {
                return -1;
            } else if (a.confirmations < b.confirmations) {
                return 1;
            }

            return 0;
        });

        const amountSatoshi: BigNumber = transfers.map(t => t.amountSatoshi).reduce(
            (a, b) => a.add(b), BigNumber.from(0),
        );
        const psbt = new Psbt({network});

        let totalSum = BigNumber.from(0);
        let outputCounts = {
            'P2WSH': 2 + transfers.length, // change!
        };
        let inputCounts = {
            [inputType]: 0,
        };

        let fee = BigNumber.from(0);
        for (const utxo of response) {
            const tx = await this.getRawTx(utxo.txid);

            if (tx && tx.hex) {
                const input = {
                    hash: utxo.txid,
                    index: utxo.vout,
                    nonWitnessUtxo: Buffer.from(tx.hex, 'hex'),
                    witnessScript: payment.redeem!.output,
                };

                psbt.addInput(input);
                inputCounts[inputType]++;
                totalSum = totalSum.add(BigNumber.from(Math.round(utxo.amount * 1e8)));

                fee = BigNumber.from(getByteCount(inputCounts, outputCounts) * this.gasSatoshi);
                if (totalSum.gte(amountSatoshi.add(fee))) {
                    break;
                }
            }
        }

        if (totalSum.lt(amountSatoshi.add(fee))) {
            throw new Error("too schlong");
        }

        const dataPayload: number[] = transfers.map((e) => e.nonce);
        const dataOutput = payments.embed(
            {data: [Buffer.from(dataPayload)]},
        );

        psbt.addOutput({
            script: dataOutput.output!,
            value: 0,
        });

        for (let transfer of transfers) {
            psbt.addOutput({
                address: transfer.btcAddress,
                value: transfer.amountSatoshi.toNumber(),
            });
        }

        // change money!
        psbt.addOutput({
            address: payment.address!,
            value: totalSum.sub(fee).sub(amountSatoshi).toNumber(),
        });

        return this.signTransaction({
            serializedTransaction: psbt.toBase64(),
            signedPublicKeys: [],
            requiredSignatures: this.cosigners,
        });
    }

    getTransactionTransfers(tx: PartiallySignedBitcoinTransaction): BtcTransfer[] {
        const psbtUnserialized = Psbt.fromBase64(tx.serializedTransaction, {network: this.network});
        const transferLength = psbtUnserialized.txOutputs.length - 2;
        if (transferLength < 1) {
            throw new Error(
                `The partial transaction does not have enough outputs, should have at least 3 outputs, has ${transferLength + 2}`)
        }

        const dataOutput = psbtUnserialized.txOutputs[0];
        if (dataOutput.value != 0) {
            throw new Error(`The OP_RETURN output has non-zero value!`);
        }

        if (dataOutput.script[0] != 0x6A) {
            throw new Error(`The data part does not start with OP_RETURN!`);
        }
        if (dataOutput.script[1] != dataOutput.script.length - 2) {
            throw new Error(`Invalid length field in the OP_RETURN field`);
        }

        const rv: BtcTransfer[] = psbtUnserialized.txOutputs.slice(1, -1).map((output, i) => {
            if (!output.address) {
                throw new Error(`Transaction output ${output.script} does not have address!`);
            }

            if (!output.address.startsWith(this.network.bech32)) {
                throw new Error(`The transaction ${output.script}/${output.address} does not pay to a Bech32 address!`);
            }

            const nonce = dataOutput.script[2 + i];
            // 0xFF is considered invalid!
            if (nonce < 0 || nonce >= 255) {
                throw new Error(`Invalid nonce ${nonce}`);
            }
            return {
                btcAddress: output.address!,
                amountSatoshi: BigNumber.from(output.value),
                nonce: nonce,
            };
        });

        return rv;
    }

    signTransaction(tx: PartiallySignedBitcoinTransaction): PartiallySignedBitcoinTransaction {
        if (tx.signedPublicKeys.indexOf(this.masterPublicKey) !== -1) {
            throw new Error('already signed by this node');
        }

        const childPrivateKey = bip32.fromBase58(this.masterPrivateKey, this.network).derivePath(this.keyDerivationPath);
        const ecPair = ECPair.fromWIF(childPrivateKey.toWIF(), this.network);

        const psbtUnserialized = Psbt.fromBase64(tx.serializedTransaction, {network: this.network});
        psbtUnserialized.signAllInputs(ecPair);
        const serializedTransaction = psbtUnserialized.toBase64();
        return {
            serializedTransaction,
            signedPublicKeys: [...tx.signedPublicKeys, this.masterPublicKey],
            requiredSignatures: tx.requiredSignatures,
        }
    }

    async submitTransaction(tx: PartiallySignedBitcoinTransaction) {
        const psbtFinal = Psbt.fromBase64(tx.serializedTransaction, {network: this.network});

        psbtFinal.validateSignaturesOfAllInputs();
        psbtFinal.finalizeAllInputs();

        const rawTx = psbtFinal.extractTransaction().toHex();
        await this.nodeWrapper.call('sendrawtransaction', [rawTx]);
    }

    private async getRawTx(txId: string): Promise<any> {
        return await this.nodeWrapper.call("gettransaction", [txId, true]);
    }
}