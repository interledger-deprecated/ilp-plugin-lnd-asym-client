# ilp-plugin-lightning
> Interledger.js Ledger Plugin for the Lightning Network

This plugin enables [Interledger](https://interledger.org) payments through the Bitcoin and Litecoin [Lightning Networks](https://lightning.network).

See the [ILP Lightning Demo](https://github.com/interledgerjs/ilp-lightning-demo) or the [example script](./examples/rpc-test.js) to watch this plugin in action.

## Installation

```sh
npm install --save ilp-plugin-lightning
```

## Usage

This plugin can be used with the [`ilp`](https://github.com/interledgerjs/ilp) client module or the [`ilp-connector`](https://github.com/interledgerjs/ilp-connector).

```js
const PluginLightning = require('ilp-plugin-lightning')
const plugin = new PluginLightning({
  lndUri: 'localhost:11009', // lnd rpc URI
  // Peer Details
  rpcUri: 'https://peer.example/rpc',
  peerPublicKey: '03c6adfdb4d26a7587651e0b7e20a7c1bd4f6092ebd96a67d65cb5bef0eb4c33f4',
  authToken: 'secret token decided with peer'
  // Limits
  maxBalance: '1000000' // max allowed balance in Satoshis
  maxUnsecured: '1000' // max that can be sent over Interledger before settlement over Lightning is required
})
```

See the [Ledger Plugin Interface](https://github.com/interledger/rfcs/blob/master/0004-ledger-plugin-interface/0004-ledger-plugin-interface.md) for documentation on available methods.

## How It Works

This plugin can be used by two Interledger nodes (sender to connector, connector to connector, and connector to receiver) to send payments through an instance of the Lightning Network. It uses the [Bilateral Transfer Protocol](https://github.com/interledger/rfcs/blob/master/0023-bilateral-transfer-protocol/0023-bilateral-transfer-protocol.md), implemented by the [payment channel framework](https://github.com/interledgerjs/ilp-plugin-payment-channel-framework), to send Interledger payment and quote details that cannot currently be communicated through `lnd` itself. Because of the need for an additional messaging layer, this plugin implementation only works bilaterally at present.
