import { readFile } from 'node:fs/promises';
import { createAccount, createClient } from 'genlayer-js';
import { studionet } from 'genlayer-js/chains';
import { CalldataAddress, TransactionHashVariant, TransactionStatus } from 'genlayer-js/types';

async function testClient(key) {
  const account = createAccount(key);
  const client = createClient({ chain: studionet, account });
  if (!key) await client.request({ method: 'sim_fundAccount', params: [account.address, 10 ** 18] });
  return client;
}

const key = process.env.STUDIONET_PRIVATE_KEY;
if (!key && process.env.STUDIONET_FAUCET !== '1') throw new Error('Set STUDIONET_PRIVATE_KEY or STUDIONET_FAUCET=1.');
const client = await testClient(key);
const code = await readFile(new URL('../contracts/rain_relay.py', import.meta.url), 'utf8');

async function finalized(hash) {
  const receipt = await client.waitForTransactionReceipt({
    hash, status: TransactionStatus.FINALIZED, interval: 4000, retries: 100,
  });
  const leader = receipt.consensus_data?.leader_receipt?.find((entry) => entry.mode === 'leader');
  if (leader?.execution_result !== 'SUCCESS') {
    throw new Error(leader?.genvm_result?.stderr || leader?.result?.payload || 'Contract execution failed');
  }
  return receipt;
}

let address = process.env.STUDIONET_CONTRACT_ADDRESS;
if (!address) {
  const deployHash = await client.deployContract({ code, args: [], leaderOnly: false });
  console.log('Deploy', deployHash);
  const deployment = await finalized(deployHash);
  address = deployment.data?.contract_address ?? deployment.to_address;
}
console.log('Address', address);
const read = async (id) => JSON.parse(await client.readContract({
  address, functionName: 'get_agreement', args: [id], transactionHashVariant: TransactionHashVariant.LATEST_FINAL,
}));
const write = async (signer, method, args) => {
  const hash = await signer.writeContract({ address, functionName: method, args, value: 0n, leaderOnly: false });
  console.log(method, hash);
  await finalized(hash);
};
if (process.argv.includes('--smoke')) {
  const guest = await testClient();
  const future = (offset) => new Date(Date.now() + offset * 86400000).toISOString().slice(0, 10);
  const checks = await Promise.allSettled([
    (async () => {
      if ((await read(1)).status === 'ACCEPTED') await write(client, 'settle', [1]);
      const wet = await read(1);
      if (wet.status !== 'CREDIT_DUE' || wet.daily.length !== 3) throw new Error('Wet replay failed');
      if ((await read(2)).status === 'ACCEPTED') await write(client, 'settle', [2]);
      const dry = await read(2);
      if (dry.status !== 'BELOW_TRIGGER' || dry.total !== wet.total) throw new Error('Dry replay failed');
      console.log('Finalized replays', JSON.stringify([wet, dry]));
    })(),
    (async () => {
      const sponsor = await testClient();
      const proposal = await sponsor.writeContract({
        address, functionName: 'propose',
        args: ['Riverside walking tour', new CalldataAddress(Buffer.from(guest.account.address.slice(2), 'hex')), 5150, -12, future(14), future(14), 100, 25],
        value: 0n, leaderOnly: false,
      });
      console.log('Propose', proposal);
      await finalized(proposal);
      const proposalReceipt = await client.getTransaction({ hash: proposal });
      const leader = proposalReceipt.consensus_data.leader_receipt.find((entry) => entry.mode === "leader");
      const { abi } = await import("genlayer-js");
      const id = abi.calldata.decode(Buffer.from(leader.result.raw, "base64").subarray(1));
      if ((await read(id)).status !== 'PROPOSED') throw new Error('Proposal did not persist');
      await write(guest, 'accept', [id]);
      if ((await read(id)).status !== 'ACCEPTED') throw new Error('Acceptance did not persist');
      console.log('Finalized live agreement', JSON.stringify(await read(id)));
    })(),
  ]);
  for (const result of checks) if (result.status === 'rejected') console.error(result.reason);
  if (checks.some((result) => result.status === 'rejected')) process.exitCode = 1;
}
