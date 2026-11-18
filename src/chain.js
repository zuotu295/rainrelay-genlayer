import { abi, createClient } from 'genlayer-js';
import { studionet } from 'genlayer-js/chains';
import { CalldataAddress, TransactionHashVariant, transactionsStatusNumberToName } from 'genlayer-js/types';
import deployment from './deployment.json';

export const address = import.meta.env.VITE_RAINRELAY_ADDRESS || deployment.address;
export const rpc = createClient({ chain: studionet });
export const explorer = 'https://explorer-studio.genlayer.com/tx/';
export const validAddress = /^0x[0-9a-f]{40}$/i;

export async function read(functionName, args) {
  if (!validAddress.test(address)) throw new Error('Set VITE_RAINRELAY_ADDRESS to a deployed contract.');
  const value = await rpc.readContract({
    address, functionName, args, transactionHashVariant: TransactionHashVariant.LATEST_FINAL,
  });
  return value ? JSON.parse(value) : null;
}

export function calldataAddress(wallet) {
  return new CalldataAddress(Uint8Array.from(wallet.slice(2).match(/../g), (byte) => parseInt(byte, 16)));
}

export async function connect() {
  const provider = window.ethereum;
  if (!provider?.request) throw new Error('Open RainRelay in a browser with an EIP-1193 wallet.');
  const [account] = await provider.request({ method: 'eth_requestAccounts' });
  if (!validAddress.test(account)) throw new Error('The wallet returned no valid account.');
  const chainId = '0x' + studionet.id.toString(16);
  const onStudionet = async () => Number(await provider.request({ method: 'eth_chainId' })) === studionet.id;
  const switchChain = () => provider.request({ method: 'wallet_switchEthereumChain', params: [{ chainId }] });
  if (!await onStudionet()) {
    try {
      await switchChain();
    } catch (error) {
      if (error?.code !== 4902 && error?.data?.originalError?.code !== 4902) throw error;
      await provider.request({
        method: 'wallet_addEthereumChain', params: [{
          chainId, chainName: 'GenLayer Studionet', nativeCurrency: studionet.nativeCurrency,
          rpcUrls: studionet.rpcUrls.default.http, blockExplorerUrls: ['https://explorer-studio.genlayer.com'],
        }],
      });
      if (!await onStudionet()) await switchChain();
    }
  }
  if (!await onStudionet()) throw new Error('Switch your wallet to GenLayer Studionet.');
  const [active] = await provider.request({ method: 'eth_accounts' });
  if (active?.toLowerCase() !== account.toLowerCase()) throw new Error('The wallet account changed. Try again.');
  return { account, client: createClient({ chain: studionet, account, provider }) };
}

export async function transaction(hash, method) {
  const receipt = await rpc.getTransaction({ hash });
  if (!receipt) return { state: 'Submitted', detail: 'Waiting for the network' };
  const state = receipt.statusName || receipt.status_name || transactionsStatusNumberToName[receipt.status] || receipt.status;
  if (state === 'CANCELED') return { state: 'Canceled', detail: 'Canceled on Studionet' };
  if (state !== 'FINALIZED') return { state: state === 'ACCEPTED' ? 'Accepted' : 'In consensus', detail: String(state).replaceAll('_', ' ').toLowerCase() };
  const leader = receipt.consensus_data?.leader_receipt?.find((entry) => entry.mode === 'leader');
  const encoded = typeof leader?.result === 'string' ? leader.result : leader?.result?.raw;
  if (!encoded) {
    const result = receipt.resultName || receipt.result_name;
    if (['DISAGREE', 'MAJORITY_DISAGREE', 'NO_MAJORITY', 'TIMEOUT', 'DETERMINISTIC_VIOLATION'].includes(result)) {
      return { state: 'Failed', detail: result.replaceAll('_', ' ').toLowerCase() };
    }
    return { state: 'Verifying', detail: 'Waiting for the execution receipt' };
  }
  const bytes = Uint8Array.from(atob(encoded), (character) => character.charCodeAt(0));
  if (bytes[0] === 0) {
    const result = { state: 'Finalized', detail: 'Execution succeeded' };
    if (method === 'propose') {
      const id = Number(abi.calldata.decode(bytes.slice(1)));
      if (Number.isSafeInteger(id) && id > 0) result.id = id;
    }
    return result;
  }
  const message = [1, 2].includes(bytes[0]) && new TextDecoder().decode(bytes.slice(1));
  return { state: 'Failed', detail: message || 'Execution did not settle' };
}
