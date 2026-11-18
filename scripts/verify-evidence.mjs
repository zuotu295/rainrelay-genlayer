import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { abi, createClient } from 'genlayer-js';
import { studionet } from 'genlayer-js/chains';
import { TransactionHashVariant, transactionsStatusNumberToName } from 'genlayer-js/types';

const file = (path) => readFile(new URL(path, import.meta.url), 'utf8');
const { address } = JSON.parse(await file('../src/deployment.json'));
const client = createClient({ chain: studionet });

assert.equal(Number(await client.request({ method: 'eth_chainId' })), 61999);
assert.equal(await client.getContractCode(address), await file('../contracts/rain_relay.py'));

async function checkReceipt(hash) {
  const tx = await client.getTransaction({ hash });
  assert.equal(tx.statusName || tx.status_name || transactionsStatusNumberToName[tx.status], 'FINALIZED', hash);
  assert.equal((tx.data?.contract_address ?? tx.to_address ?? tx.recipient).toLowerCase(), address.toLowerCase());
  const leader = tx.consensus_data?.leader_receipt?.find((row) => row.mode === 'leader');
  assert.equal(leader?.execution_result, 'SUCCESS', hash);
  return { tx, leader };
}

async function agreement(id) {
  return JSON.parse(await client.readContract({
    address, functionName: 'get_agreement', args: [id],
    transactionHashVariant: TransactionHashVariant.LATEST_FINAL,
  }));
}

await checkReceipt('0x4fcbba486c261b69a4fc6f092c66bc4eac99ce2df9d8f3784866a9367a818f82');

for (const [id, threshold, outcome, hash] of [
  [1, 10, 'CREDIT_DUE', '0x0343c002a7c814695c28106f97a60ce8af3fe0267ae4fbc17f22109131df1aef'],
  [2, 500, 'BELOW_TRIGGER', '0xe5a62fdd0758fe9cb4037de4b1d96213a22a35c6d0af7aaffb5c83d740d01c10'],
]) {
  const [{ leader }, record] = await Promise.all([checkReceipt(hash), agreement(id)]);
  const outputs = Object.values(leader.eq_outputs ?? {});
  assert.equal(outputs.length, 1, hash);
  const bytes = Buffer.from(typeof outputs[0] === 'string' ? outputs[0] : outputs[0].raw, 'base64');
  assert.equal(bytes[0], 0, hash);
  const daily = abi.calldata.decode(bytes.subarray(1)).map(Number);
  assert.deepEqual(daily, [52, 86, 10]);
  assert.deepEqual(record.daily, daily);
  assert.equal(record.total, daily.reduce((sum, value) => sum + value, 0));
  assert.equal(record.threshold, threshold);
  assert.equal(record.status, outcome);
  assert.equal(record.replay, true);
  console.log('Finalized replay', id, outcome, hash);
}

const live = await agreement(6);
assert.equal(live.replay, false);
assert.ok(/^0x[0-9a-f]{40}$/i.test(live.sponsor) && /^0x[0-9a-f]{40}$/i.test(live.guest));
assert.notEqual(live.sponsor.toLowerCase(), live.guest.toLowerCase());
assert.equal(live.start, '2026-11-19');
assert.equal(live.end, '2026-11-19');
assert.ok(['ACCEPTED', 'CREDIT_DUE', 'BELOW_TRIGGER', 'REDEEMED'].includes(live.status));
console.log('Finalized live agreement #6', live.status);

const proposalHash = '0xa03a1f0cf54ac3c8c9a562623b425edb5425bba087886329ea005e21a43ebf2c';
const acceptanceHash = '0x24848ef1f050f225a72ab7bef00d5aba5dfaf308dc4436534fd0c90c8ef51de7';
const [proposal, acceptance] = await Promise.all([checkReceipt(proposalHash), checkReceipt(acceptanceHash)]);
const calldata = (tx) => abi.calldata.decode(Buffer.from(tx.data.calldata.base64, 'base64'));
assert.equal(proposal.tx.from_address.toLowerCase(), live.sponsor.toLowerCase());
assert.equal(acceptance.tx.from_address.toLowerCase(), live.guest.toLowerCase());
assert.equal(calldata(proposal.tx).get('method'), 'propose');
const proposedId = Buffer.from(proposal.leader.result.raw, 'base64');
assert.equal(proposedId[0], 0);
assert.equal(Number(abi.calldata.decode(proposedId.subarray(1))), 6);
const acceptedCall = calldata(acceptance.tx);
assert.equal(acceptedCall.get('method'), 'accept');
assert.deepEqual(acceptedCall.get('args').map(Number), [6]);
console.log('Finalized live proposal and acceptance receipts', proposalHash, acceptanceHash);
