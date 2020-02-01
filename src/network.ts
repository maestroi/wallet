/* eslint-disable no-console */
import { watch } from '@vue/composition-api'
import { NetworkClient } from '@nimiq/network-client'

import { useAccountsStore } from './stores/Accounts'
import { useTransactionsStore, Transaction } from './stores/Transactions'
import { useNetworkStore } from './stores/Network'

let isLaunched = false

export async function launchNetwork() {
    if (isLaunched) return
    isLaunched = true

    const client = NetworkClient.createInstance()
    await client.init()

    const { state: network$ } = useNetworkStore()
    const transactionsStore = useTransactionsStore()
    const { state: transactions$ } = transactionsStore
    const { activeAddress, state: accounts$ } = useAccountsStore()

    function balancesListener(balances: Map<string, number>) {
        console.debug('Got new balances for', [...balances.keys()])
        for (const [address, balance] of balances) {
            accounts$.accounts[address] = {
                ...accounts$.accounts[address],
                balance,
            }
        }
    }
    client.on(NetworkClient.Events.BALANCES, balancesListener)

    client.on(NetworkClient.Events.CONSENSUS, consensus => network$.consensus = consensus)

    client.on(NetworkClient.Events.HEAD_HEIGHT, height => {
        console.debug('Head is now at', height)
        network$.height = height
    })

    client.on(NetworkClient.Events.PEER_COUNT, peerCount => network$.peerCount = peerCount)

    function transactionListener(plain: ReturnType<Nimiq.Client.TransactionDetails['toPlain']>) {
        transactions$.transactions = {
            ...transactions$.transactions,
            [plain.transactionHash]: plain,
        }
    }
    client.on(NetworkClient.Events.TRANSACTION, transactionListener)

    // Subscribe to new addresses (for balance updates and transactions)
    const subscribedAddresses = new Set<string>()
    watch(() => {
        const newAddresses: string[] = []
        for (const address in accounts$.accounts) {
            if (subscribedAddresses.has(address)) continue
            subscribedAddresses.add(address)
            newAddresses.push(address)
        }
        if (!newAddresses.length) return

        console.debug('Subscribing addresses', newAddresses)
        client.subscribe(newAddresses)
    })

    // Fetch transactions for active account
    const fetchedAddresses = new Set<string>()
    watch(activeAddress, () => {
        const address = activeAddress.value

        if (!address || fetchedAddresses.has(address)) return
        fetchedAddresses.add(address)

        const knownTxDetails = Object.values(transactions$.transactions)
            .filter(tx => tx.sender === address || tx.recipient === address)

        network$.fetchingTxHistory++

        console.debug('Fetching transaction history for', address, knownTxDetails)
        client.getTransactionsByAddress(address, 0, knownTxDetails, 100).then(txDetails => {
            const txs: {[hash: string]: Transaction} = {}
            for (const plain of txDetails) {
                txs[plain.transactionHash] = plain
            }

            transactions$.transactions = {
                ...transactions$.transactions,
                ...txs,
            }
        })
        .finally(() => network$.fetchingTxHistory--)
    })
}
