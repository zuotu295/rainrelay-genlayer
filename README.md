# RainRelay

RainRelay is a shared workspace for weather-contingent booking credits. Outdoor tour operators, market organizers, and venue hosts can lock the terms of a rain policy before the booking. The customer can inspect and accept the same terms. After the archive is ready, GenLayer determines whether the sponsor owes the agreed service credit.

## Try the app

- [RainRelay on GitHub Pages](https://zuotu295.github.io/rainrelay-genlayer/)
- [Replay 1 — credit due](https://zuotu295.github.io/rainrelay-genlayer/?agreement=1)
- [Replay 2 — below trigger](https://zuotu295.github.io/rainrelay-genlayer/?agreement=2)

Both replays use the same London archive window (21–23 February 2024 UTC). GenLayer finalized daily values of **5.2, 8.6, and 1.0 mm**. The 14.8 mm total meets the 1.0 mm replay threshold and stays below the 50.0 mm replay threshold. The app reads these values from finalized contract storage. Replay credits are illustrative and cannot be redeemed.

### Real agreement workflow

1. The sponsor connects an EIP-1193 wallet to GenLayer Studionet (61999) and proposes a future agreement with a distinct customer wallet. Terms include coordinates, one to seven UTC days, a precipitation threshold, and the amount of service credit.
2. The named customer reviews the locked terms and accepts from their own wallet before the UTC start day. A pending offer expires at the cutoff.
3. Beginning eight UTC days after the final observation day, anyone can request settlement. An incomplete archive leaves the agreement available for retry. The contract compares the agreed, tenths-of-a-millimeter total against the threshold, inclusive.
4. A triggered agreement records the outstanding credit. The sponsor applies it in its booking system and then acknowledges redemption on-chain with a non-sensitive booking reference. This is a one-way state transition that prevents duplicate acknowledgments for the same agreement.

Credits are service units honored by the named sponsor. RainRelay has no token, escrow, payment processor, or fiat exchange rate. A participant should only put public booking references and non-sensitive titles on-chain. Historical agreements remain readable through share links.

## Why GenLayer

A normal booking database lets one party control both the terms and the weather outcome. Here, only the named wallet can accept an offer, neither party can amend accepted terms, and settlement has no privileged operator. GenLayer validators independently request the same Open-Meteo ERA5 archive dates and agree on the normalized daily series using `gl.eq_principle.strict_eq`. Date coverage and units must match. The deterministic contract converts the agreed series into `CREDIT_DUE` or `BELOW_TRIGGER`, and blocks settlement or redemption from an invalid prior state.

[Open-Meteo's ERA5 historical feed](https://open-meteo.com/en/docs/historical-weather-api) publishes gridded estimates of total precipitation, including snow. They are defined for the selected grid and UTC day, with possible differences from a physical gauge at the venue. A sponsor can use RainRelay for each new eligible booking and manually apply finalized credits, or periodically reconcile its finalized agreements using `list_agreements` and `get_agreement`. Sponsors should choose their venue, dates and threshold with that data model in mind.

## Development and deployment

Node.js 24. The Svelte 5 frontend is built as a static site with Vite.

```sh
npm ci
npm run dev
npm run build
```

Public Studionet contract (Chain ID 61999): [`0x31e29eC685E6158Bf331b6C7C7A455F00458C90C`](https://explorer-studio.genlayer.com/address/0x31e29eC685E6158Bf331b6C7C7A455F00458C90C).

- [Deployment transaction](https://explorer-studio.genlayer.com/tx/0x4fcbba486c261b69a4fc6f092c66bc4eac99ce2df9d8f3784866a9367a818f82)
- [Credit-due replay](https://explorer-studio.genlayer.com/tx/0x0343c002a7c814695c28106f97a60ce8af3fe0267ae4fbc17f22109131df1aef)
- [Below-trigger replay](https://explorer-studio.genlayer.com/tx/0xe5a62fdd0758fe9cb4037de4b1d96213a22a35c6d0af7aaffb5c83d740d01c10)

### Automated verification

Every push to `main` and every pull request targeting `main` runs the frontend production build, validates the configured contract address, and checks the contract's Python syntax. Successful pushes to `main` continue to publish the GitHub Pages site.

The Studionet contract verification workflow checks both finalized replay outcomes and creates a fresh, non-replay agreement using two temporary faucet-backed test accounts. It verifies the proposal and customer acceptance on-chain. Because the contract only permits settlement after the observation window and an eight-day archive publication delay, the workflow checks maturity daily and then submits a real `settle` transaction. The settlement check reads back the finalized daily observations, verifies their sum, and checks that the final status matches the agreed threshold. The test does not deploy a replacement contract.

The dependency security workflow strictly audits production dependencies and fails on any high- or critical-severity production finding. It also scans the complete development toolchain; the currently unpatched, dev-only Picomatch advisory and its mitigation are documented in [SECURITY.md](SECURITY.md).

To deploy a separate Studionet instance, use a funded account via `STUDIONET_PRIVATE_KEY` or a fresh faucet account:

```sh
STUDIONET_FAUCET=1 npm run deploy:contract
```

When deploying a separate instance, update `src/deployment.json` for a new frontend deployment, or pass `VITE_RAINRELAY_ADDRESS` at build time. GitHub Pages publishes the `dist/` build via Actions. The contract uses Studionet test infrastructure and eventual finality.

## GenLayer Projects submission

- **Project name** — RainRelay
- **Category** — Projects
- **Primary tag** — Other
- **Repository** — [Source code](https://github.com/zuotu295/rainrelay-genlayer)
- **Live demo** — [Weather agreement desk](https://zuotu295.github.io/rainrelay-genlayer/)
- **Description** — RainRelay gives outdoor booking operators and customers a shared way to agree on weather-triggered service credits. Parties lock and accept the same terms before a booking, then GenLayer validators independently fetch the ERA5 archive published by Open-Meteo and agree on whether the credit is due. The Svelte app displays the daily rainfall evidence, contract state, and transaction lifecycle.
