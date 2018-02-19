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
See the [Ledger Plugin Interface](https://github.com/interledger/rfcs/blob/master/0004-ledger-plugin-interface/0004-ledger-plugin-interface.md) for documentation on available methods.

* Connect to the lightning testnet:
```sh
export GOPATH=~/gocode
export PATH=$PATH:$GOPATH/bin
lnd --bitcoin.active --bitcoin.testnet --debuglevel=debug --bitcoin.node=neutrino --neutrino.connect=faucet.lightning.community --datadir=./data --no-macaroons
```

Check your settings in ~/Library/Application\ Support/Lnd/lnd.conf, you can also set options like `--bitcoin.testnet` there instead of on the command line.
* Use lncli to create a wallet, see http://dev.lightning.community/tutorial/01-lncli/ for inspiration on how to do this
```sh
lncli --no-macaroons create
lncli --no-macaroons getinfo
lncli --no-macaroons newaddress np2wkh
lncli --no-macaroons walletbalance witness-only=true
```

* Run `DEBUG=* node test.js`

... you will run into https://github.com/interledgerjs/ilp-plugin-lnd-asym-server/issues/2  (will fix asap)

## How It Works

This plugin can be used by two Interledger nodes (sender to connector, connector to connector, and connector to receiver) to send payments through an instance of the Lightning Network. It uses the [Bilateral Transfer Protocol](https://github.com/interledger/rfcs/blob/master/0023-bilateral-transfer-protocol/0023-bilateral-transfer-protocol.md), implemented by the [payment channel framework](https://github.com/interledgerjs/ilp-plugin-payment-channel-framework), to send Interledger payment and quote details that cannot currently be communicated through `lnd` itself. Because of the need for an additional messaging layer, this plugin implementation only works bilaterally at present.
