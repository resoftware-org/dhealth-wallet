/*
 * Copyright 2020 NEM (https://nem.io)
 *
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License.
 * You may obtain a copy of the License at
 *
 *      http://www.apache.org/licenses/LICENSE-2.0
 *
 * Unless required by applicable law or agreed to in writing, software
 * distributed under the License is distributed on an "AS IS" BASIS,
 * WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
 * See the License for the specific language governing permissions and limitations under the License.
 *
 */
import { HarvestingModel } from '@/core/database/entities/HarvestingModel';
import { NodeModel } from '@/core/database/entities/NodeModel';
import { URLHelpers } from '@/core/utils/URLHelpers';
import { HarvestingService } from '@/services/HarvestingService';
import { PageInfo } from '@/store/Transaction';
import { map, reduce } from 'rxjs/operators';
import { AccountInfo, ReceiptType, RepositoryFactoryHttp, SignedTransaction, UInt64 } from 'symbol-sdk';

// @FIXME: @dhealth/sdk@1.0.3-alpha-202110081200 includes a fix for `PaginationStreamer` to use
//         the correct rxjs imports (v6) for `defer` and `from` method. Next wallet version should
//         replace the symbol-sdk dependency to @dhealth/sdk completely. This comment can be deleted
//         when the dependency swap has happened.
import {
    Address,
    Order,
    ReceiptPaginationStreamer,
    TransactionStatementSearchCriteria,
    BalanceChangeReceipt,
    RepositoryFactory,
} from '@dhealth/sdk';

import Vue from 'vue';
// internal dependencies
import { AwaitLock } from './AwaitLock';

const Lock = AwaitLock.create();

export type HarvestedBlock = {
    blockNo: UInt64;
    fee: UInt64;
};

export type HarvestedBlockStats = {
    totalBlockCount: number;
    totalFeesEarned: UInt64;
};

export enum HarvestingStatus {
    ACTIVE = 'ACTIVE',
    INACTIVE = 'INACTIVE',
    KEYS_LINKED = 'KEYS_LINKED',
    INPROGRESS_ACTIVATION = 'INPROGRESS_ACTIVATION',
    INPROGRESS_DEACTIVATION = 'INPROGRESS_DEACTIVATION',
    FAILED = 'FAILED',
}

export enum LedgerHarvestingMode {
    DELEGATED_HARVESTING_START_OR_SWAP = 'DELEGATED_HARVESTING_START_OR_SWAP',
    DELEGATED_HARVESTING_STOP = 'DELEGATED_HARVESTING_STOP',
    MULTISIG_DELEGATED_HARVESTING_START_OR_SWAP = 'MULTISIG_DELEGATED_HARVESTING_START_OR_SWAP',
    MULTISIG_DELEGATED_HARVESTING_STOP = 'MULTISIG_DELEGATED_HARVESTING_STOP',
}
interface HarvestingState {
    initialized: boolean;
    harvestedBlocks: HarvestedBlock[];
    isFetchingHarvestedBlocks: boolean;
    harvestedBlocksPageInfo: PageInfo;
    status: HarvestingStatus;
    harvestedBlockStats: HarvestedBlockStats;
    isFetchingHarvestedBlockStats: boolean;
    currentSignerHarvestingModel: HarvestingModel;
    pollingTrials: number;
}

const initialState: HarvestingState = {
    initialized: false,
    harvestedBlocks: null,
    isFetchingHarvestedBlocks: false,
    harvestedBlocksPageInfo: { pageNumber: 1, isLastPage: false },
    status: HarvestingStatus.INACTIVE,
    harvestedBlockStats: {
        totalBlockCount: 0,
        totalFeesEarned: UInt64.fromUint(0),
    },
    isFetchingHarvestedBlockStats: false,
    currentSignerHarvestingModel: null,
    pollingTrials: 1,
};

export default {
    namespaced: true,
    state: initialState,
    getters: {
        getInitialized: (state) => state.initialized,
        harvestedBlocks: (state) => state.harvestedBlocks,
        isFetchingHarvestedBlocks: (state) => state.isFetchingHarvestedBlocks,
        harvestedBlocksPageInfo: (state) => state.harvestedBlocksPageInfo,
        status: (state) => state.status,
        harvestedBlockStats: (state) => state.harvestedBlockStats,
        isFetchingHarvestedBlockStats: (state) => state.isFetchingHarvestedBlockStats,
        currentSignerHarvestingModel: (state) => state.currentSignerHarvestingModel,
        pollingTrials: (state) => state.pollingTrials,
    },
    mutations: {
        setInitialized: (state, initialized) => {
            state.initialized = initialized;
        },
        harvestedBlocks: (state, { harvestedBlocks, pageInfo }) => {
            Vue.set(state, 'harvestedBlocks', harvestedBlocks);
            Vue.set(state, 'harvestedBlocksPageInfo', pageInfo);
        },
        isFetchingHarvestedBlocks: (state, isFetchingHarvestedBlocks) =>
            Vue.set(state, 'isFetchingHarvestedBlocks', isFetchingHarvestedBlocks),
        status: (state, status) => Vue.set(state, 'status', status),
        harvestedBlockStats: (state, harvestedBlockStats) => Vue.set(state, 'harvestedBlockStats', harvestedBlockStats),
        isFetchingHarvestedBlockStats: (state, isFetchingHarvestedBlockStats) =>
            Vue.set(state, 'isFetchingHarvestedBlockStats', isFetchingHarvestedBlockStats),
        currentSignerHarvestingModel: (state, currentSignerHarvestingModel) =>
            Vue.set(state, 'currentSignerHarvestingModel', currentSignerHarvestingModel),
        setPollingTrials: (state, pollingTrials) => {
            Vue.set(state, 'pollingTrials', pollingTrials);
        },
    },
    actions: {
        async initialize({ commit, getters }) {
            const callback = async () => {
                // update store
                commit('setInitialized', true);
            };

            // acquire async lock until initialized
            await Lock.initialize(callback, { getters });
        },
        async uninitialize({ commit, getters }) {
            const callback = async () => {
                commit('setInitialized', false);
            };
            await Lock.uninitialize(callback, { getters });
        },
        /// region scoped actions
        RESET_STATE({ commit }) {
            commit('harvestedBlocks', { harvestedBlocks: null, pageInfo: { pageNumber: 1, isLastPage: false } });
            commit('isFetchingHarvestedBlocks', false);
        },
        SET_POLLING_TRIALS({ commit }, pollingTrials) {
            commit('setPollingTrials', pollingTrials);
        },
        async FETCH_STATUS({ commit, rootGetters }, nodeUrl?: string) {
            const currentSignerAccountInfo: AccountInfo = rootGetters['account/currentSignerAccountInfo'];
            // reset
            let status: HarvestingStatus;
            if (!currentSignerAccountInfo) {
                return;
            }
            const currentSignerHarvestingModel: HarvestingModel = rootGetters['harvesting/currentSignerHarvestingModel'];
            let accountUnlocked = false;

            if (currentSignerHarvestingModel) {
                //find the node url from currentSignerHarvestingModel (localStorage)
                const selectedNode = currentSignerHarvestingModel.selectedHarvestingNode;
                const harvestingNodeUrl = selectedNode?.url || nodeUrl;
                let unlockedAccounts: string[] = [];

                if (harvestingNodeUrl) {
                    const repositoryFactory = new RepositoryFactoryHttp(URLHelpers.getNodeUrl(harvestingNodeUrl));
                    const nodeRepository = repositoryFactory.createNodeRepository();
                    try {
                        unlockedAccounts = await nodeRepository.getUnlockedAccount().toPromise();
                    } catch (error) {
                        //proceed
                    }
                }
                const remotePublicKey = currentSignerAccountInfo.supplementalPublicKeys?.linked?.publicKey;
                accountUnlocked = unlockedAccounts?.some((publicKey) => publicKey === remotePublicKey);
            }
            const allKeysLinked =
                currentSignerAccountInfo.supplementalPublicKeys?.linked &&
                currentSignerAccountInfo.supplementalPublicKeys?.node &&
                currentSignerAccountInfo.supplementalPublicKeys?.vrf;
            if (allKeysLinked) {
                const pollingTrials = rootGetters['harvesting/pollingTrials'];
                status = accountUnlocked
                    ? HarvestingStatus.ACTIVE
                    : currentSignerHarvestingModel?.isPersistentDelReqSent
                    ? pollingTrials === 20 || currentSignerHarvestingModel?.delegatedHarvestingRequestFailed
                        ? HarvestingStatus.FAILED
                        : HarvestingStatus.INPROGRESS_ACTIVATION
                    : HarvestingStatus.KEYS_LINKED;
            } else {
                status = accountUnlocked ? HarvestingStatus.INPROGRESS_DEACTIVATION : HarvestingStatus.INACTIVE;
            }
            commit('status', status);
        },
        LOAD_HARVESTED_BLOCKS({ commit, rootGetters }, { pageNumber, pageSize }: { pageNumber: number; pageSize: number }) {
            const repositoryFactory: RepositoryFactory = rootGetters['network/repositoryFactory'];
            const receiptRepository = repositoryFactory.createReceiptRepository();

            const currentSignerAddress: Address = rootGetters['account/currentSignerAddress'];
            if (!currentSignerAddress) {
                return;
            }

            const targetAddress = currentSignerAddress;
            // for testing => const targetAddress = Address.createFromRawAddress('TD5YTEJNHOMHTMS6XESYAFYUE36COQKPW6MQQQY');

            commit('isFetchingHarvestedBlocks', true);

            receiptRepository
                .searchReceipts({
                    targetAddress: targetAddress,
                    receiptTypes: [ReceiptType.Harvest_Fee],
                    pageNumber: pageNumber,
                    pageSize: pageSize,
                    order: Order.Desc,
                } as TransactionStatementSearchCriteria)
                .pipe(
                    map((pageTxStatement) => {
                        const harvestedBlocks = pageTxStatement.data.map(
                            (t) =>
                                (({
                                    blockNo: t.height,
                                    fee: (t.receipts as BalanceChangeReceipt[]).find(
                                        (r) => r.targetAddress.plain() === targetAddress.plain(),
                                    )?.amount,
                                } as unknown) as HarvestedBlock),
                        );
                        const pageInfo = { isLastPage: pageTxStatement.isLastPage, pageNumber: pageTxStatement.pageNumber };

                        commit('harvestedBlocks', { harvestedBlocks, pageInfo });
                    }),
                )
                .subscribe({ complete: () => commit('isFetchingHarvestedBlocks', false) });
        },
        LOAD_HARVESTED_BLOCKS_STATS({ commit, dispatch, rootGetters }) {
            const repositoryFactory: RepositoryFactory = rootGetters['network/repositoryFactory'];
            const receiptRepository = repositoryFactory.createReceiptRepository();
            const streamer = ReceiptPaginationStreamer.transactionStatements(receiptRepository);

            const currentSignerAddress: Address = rootGetters['account/currentSignerAddress'];
            if (!currentSignerAddress) {
                return;
            }

            const targetAddress = currentSignerAddress;
            // for testing => const targetAddress = Address.createFromRawAddress('TD5YTEJNHOMHTMS6XESYAFYUE36COQKPW6MQQQY');

            commit('isFetchingHarvestedBlockStats', true);
            let totalBlockCount = 0;
            const seed = { totalBlockCount, totalFeesEarned: UInt64.fromUint(0) };
            streamer
                .search({
                    targetAddress: targetAddress,
                    receiptTypes: [ReceiptType.Harvest_Fee],
                    pageNumber: 1,
                    pageSize: 50,
                } as TransactionStatementSearchCriteria)
                .pipe(
                    map((t) => {
                        return ({
                            blockNo: t.height,
                            fee: (t.receipts as BalanceChangeReceipt[]).find((r) => r.targetAddress.plain() === targetAddress.plain())
                                ?.amount,
                        } as unknown) as HarvestedBlock;
                    }),
                    reduce(
                        (acc, harvestedBlock) => ({
                            totalBlockCount: ++totalBlockCount,
                            totalFeesEarned: acc.totalFeesEarned.add(harvestedBlock.fee),
                        }),
                        seed,
                    ),
                )
                .subscribe({
                    next: (harvestedBlockStats) => {
                        commit('harvestedBlockStats', harvestedBlockStats);
                    },
                    error: (err) => {
                        dispatch('notification/ADD_ERROR', `An error happened requesting harvesting statistics: ${err.toString()}`, {
                            root: true,
                        });

                        commit('harvestedBlockStats', seed);
                        commit('isFetchingHarvestedBlockStats', false);
                    },
                    complete: () => commit('isFetchingHarvestedBlockStats', false),
                });
        },
        SET_CURRENT_SIGNER_HARVESTING_MODEL({ commit }, currentSignerAddress) {
            const harvestingService = new HarvestingService();
            let harvestingModel = harvestingService.getHarvestingModel(currentSignerAddress);
            if (!harvestingModel) {
                harvestingModel = { accountAddress: currentSignerAddress };
                harvestingService.saveHarvestingModel(harvestingModel);
            }
            commit('currentSignerHarvestingModel', harvestingModel);
        },
        UPDATE_ACCOUNT_SIGNED_PERSISTENT_DEL_REQ_TXS(
            { commit },
            { accountAddress, signedPersistentDelReqTxs }: { accountAddress: string; signedPersistentDelReqTxs: SignedTransaction[] },
        ) {
            const harvestingService = new HarvestingService();
            const harvestingModel = harvestingService.getHarvestingModel(accountAddress);
            harvestingService.updateSignedPersistentDelReqTxs(harvestingModel, signedPersistentDelReqTxs);
            commit('currentSignerHarvestingModel', harvestingModel);
        },
        UPDATE_ACCOUNT_IS_PERSISTENT_DEL_REQ_SENT(
            { commit },
            { accountAddress, isPersistentDelReqSent }: { accountAddress: string; isPersistentDelReqSent: boolean },
        ) {
            const harvestingService = new HarvestingService();
            const harvestingModel = harvestingService.getHarvestingModel(accountAddress);
            harvestingService.updateIsPersistentDelReqSent(harvestingModel, isPersistentDelReqSent);
            commit('currentSignerHarvestingModel', harvestingModel);
        },
        UPDATE_ACCOUNT_SELECTED_HARVESTING_NODE(
            { commit },
            { accountAddress, selectedHarvestingNode }: { accountAddress: string; selectedHarvestingNode: NodeModel },
        ) {
            const harvestingService = new HarvestingService();
            const harvestingModel = harvestingService.getHarvestingModel(accountAddress);
            harvestingService.updateSelectedHarvestingNode(harvestingModel, selectedHarvestingNode);
            commit('currentSignerHarvestingModel', harvestingModel);
            harvestingService.updateDelegatedHarvestingRequestFailed(harvestingModel, false);
            commit('setPollingTrials', 1);
        },
        UPDATE_REMOTE_ACCOUNT_PRIVATE_KEY(
            { commit },
            { accountAddress, encRemotePrivateKey }: { accountAddress: string; encRemotePrivateKey: string },
        ) {
            const harvestingService = new HarvestingService();
            const harvestingModel = harvestingService.getHarvestingModel(accountAddress);
            harvestingService.updateRemoteKey(harvestingModel, encRemotePrivateKey);
            commit('currentSignerHarvestingModel', harvestingModel);
        },
        UPDATE_VRF_ACCOUNT_PRIVATE_KEY(
            { commit },
            { accountAddress, encVrfPrivateKey }: { accountAddress: string; encVrfPrivateKey: string },
        ) {
            const harvestingService = new HarvestingService();
            const harvestingModel = harvestingService.getHarvestingModel(accountAddress);
            harvestingService.updateVrfKey(harvestingModel, encVrfPrivateKey);
            commit('currentSignerHarvestingModel', harvestingModel);
        },
        UPDATE_HARVESTING_REQUEST_STATUS(
            { commit },
            { accountAddress, delegatedHarvestingRequestFailed }: { accountAddress: string; delegatedHarvestingRequestFailed: boolean },
        ) {
            const harvestingService = new HarvestingService();
            const harvestingModel = harvestingService.getHarvestingModel(accountAddress);
            harvestingService.updateDelegatedHarvestingRequestFailed(harvestingModel, delegatedHarvestingRequestFailed);
            commit('currentSignerHarvestingModel', harvestingModel);
        },
        /// end-region scoped actions
    },
};
