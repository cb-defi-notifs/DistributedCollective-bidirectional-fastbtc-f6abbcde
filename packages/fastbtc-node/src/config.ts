export interface Config {
    dbUrl: string;
    knownPeers: string[];
    port: number;
    rskRpcUrl: string;
    rskContractAddress: string;
    rskStartBlock: number;
    rskRequiredConfirmations: number;
    rskPrivateKey: string; // secret
    btcNetwork: 'mainnet' | 'testnet' | 'regtest';
    btcRpcUrl: string;
    btcRpcUsername: string;
    btcRpcPassword: string; // secret
    btcMasterPrivateKey: string; // secret
    btcMasterPublicKeys: string[]; // secret
    btcKeyDerivationPath: string;
}
const defaults = {
    port: 11125,
}
const VALID_BTC_NETWORKS = ['mainnet', 'testnet', 'regtest'];

export const Config = Symbol.for('Config');

class InvalidConfig extends Error {
}

export const createEnvConfig = (env = process.env, allowPartial: boolean = false): Config => {
    if (!allowPartial) {
        for (let key of [
            'FASTBTC_DB_URL',
            'FASTBTC_KNOWN_PEERS',
            'FASTBTC_RSK_RPC_URL',
            'FASTBTC_RSK_CONTRACT_ADDRESS',
            'FASTBTC_RSK_START_BLOCK',
            'FASTBTC_RSK_PRIVATE_KEY',
            'FASTBTC_BTC_NETWORK',
            'FASTBTC_BTC_RPC_URL',
            'FASTBTC_BTC_MASTER_PRIVATE_KEY',
            'FASTBTC_BTC_MASTER_PUBLIC_KEYS',
        ]) {
            if (!env[key]) {
                throw new InvalidConfig(`Required env variable ${key} missing`)
            }
        }
    }

    let {
        port
    } = defaults;
    if (env.FASTBTC_PORT) {
        port = parseInt(env.FASTBTC_PORT);
        if(!port) {
            throw new InvalidConfig(`Invalid port: ${env.FASTBTC_PORT}`);
        }
    }
    if(VALID_BTC_NETWORKS.indexOf(env.FASTBTC_BTC_NETWORK!) === -1) {
        throw new InvalidConfig(
            `Invalid network: ${env.FASTBTC_BTC_NETWORK}, must be one of: ${VALID_BTC_NETWORKS.join(', ')}`
        );
    }

    return {
        dbUrl: env.FASTBTC_DB_URL!,
        knownPeers: parseKnownPeers(env.FASTBTC_KNOWN_PEERS!),
        port,
        rskRpcUrl: env.FASTBTC_RSK_RPC_URL!,
        rskContractAddress: env.FASTBTC_RSK_CONTRACT_ADDRESS!,
        rskStartBlock: parseInt(env.FASTBTC_RSK_START_BLOCK!),
        rskRequiredConfirmations: parseInt(env.FASTBTC_RSK_REQUIRED_CONFIRMATIONS ?? '10'),
        rskPrivateKey: env.FASTBTC_RSK_PRIVATE_KEY!,
        btcNetwork: env.FASTBTC_BTC_NETWORK! as 'mainnet'|'testnet'|'regtest',
        btcRpcUrl: env.FASTBTC_BTC_RPC_URL!,
        btcRpcUsername: env.FASTBTC_BTC_RPC_USERNAME ?? '',
        btcRpcPassword: env.FASTBTC_BTC_RPC_PASSWORD ?? '',
        btcMasterPrivateKey: env.FASTBTC_BTC_MASTER_PRIVATE_KEY!,
        btcMasterPublicKeys: env.FASTBTC_BTC_MASTER_PUBLIC_KEYS!.split(',').map(x => x.trim()),
        btcKeyDerivationPath: env.FASTBTC_BTC_KEY_DERIVATION_PATH ?? 'm/0/0/0',
    }
};

function parseKnownPeers(raw: string) {
    const knownPeers = raw.split(',').map(s => s.trim()).filter(s => s);
    if(knownPeers.length < 1) {
        throw new InvalidConfig(`At least 1 known peer must be given in FASTBTC_KNOWN_PEERS`);
    }
    for(let s of knownPeers) {
        const parts = s.split(':')
        if(parts.length !== 2) {
            throw new InvalidConfig(`Known peers must be of format "hostname:port" (got "${s}")`);
        }
    }
    return knownPeers;
}
