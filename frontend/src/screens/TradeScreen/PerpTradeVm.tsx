import React, { useMemo } from "react";
import { useVM } from "@src/hooks/useVM";
import { makeAutoObservable, reaction } from "mobx";
import { RootStore, useStores } from "@stores";
import { CONTRACT_ADDRESSES, TOKENS_BY_ASSET_ID, TOKENS_BY_SYMBOL } from "@src/constants";
import BN from "@src/utils/BN";
import {
	AccountBalanceAbi,
	AccountBalanceAbi__factory,
	ClearingHouseAbi,
	ClearingHouseAbi__factory,
	InsuranceFundAbi,
	InsuranceFundAbi__factory,
	PerpMarketAbi,
	PerpMarketAbi__factory,
	ProxyAbi,
	ProxyAbi__factory,
	VaultAbi,
	VaultAbi__factory,
} from "@src/contracts";

const ctx = React.createContext<PerpTradeVm | null>(null);

interface IProps {
	children: React.ReactNode;
}

interface ContractConfig {
	proxyContract: ProxyAbi;
	accountBalanceContract: AccountBalanceAbi;
	clearingHouseContract: ClearingHouseAbi;
	insuranceFundContract: InsuranceFundAbi;
	perpMarketContract: PerpMarketAbi;
	vaultMarketContract: VaultAbi;
}

export const PerpTradeVMProvider: React.FC<IProps> = ({ children }) => {
	const rootStore = useStores();
	const store = useMemo(() => new PerpTradeVm(rootStore), [rootStore]);
	return <ctx.Provider value={store}>{children}</ctx.Provider>;
};

type OrderAction = "long" | "short";

export const usePerpTradeVM = () => useVM(ctx);

class PerpTradeVm {
	public rootStore: RootStore;

	initialized: boolean = false;
	private setInitialized = (l: boolean) => (this.initialized = l);

	contracts: ContractConfig | null = null;
	private setContract = (c: ContractConfig | null) => (this.contracts = c);

	rejectUpdateStatePromise?: () => void;
	setRejectUpdateStatePromise = (v: any) => (this.rejectUpdateStatePromise = v);

	maxAbsPositionSize?: { long: BN; short: BN } | null = null;
	setMaxAbsPositionSize = (v: { long: BN; short: BN } | null) => (this.maxAbsPositionSize = v);

	constructor(rootStore: RootStore) {
		this.rootStore = rootStore;
		this.updateMarket();
		makeAutoObservable(this);
		reaction(
			() => [this.rootStore.tradeStore.marketSymbol],
			() => this.updateMarket(),
		);
	}

	initContracts = async () => {
		const { accountStore } = this.rootStore;
		const wallet = await accountStore.getWallet();
		if (wallet == null) return;
		const proxyContract = ProxyAbi__factory.connect(CONTRACT_ADDRESSES.proxy, wallet);
		const accountBalanceContract = AccountBalanceAbi__factory.connect(CONTRACT_ADDRESSES.accountBalance, wallet);
		const clearingHouseContract = ClearingHouseAbi__factory.connect(CONTRACT_ADDRESSES.clearingHouse, wallet);
		const insuranceFundContract = InsuranceFundAbi__factory.connect(CONTRACT_ADDRESSES.insuranceFund, wallet);
		const perpMarketContract = PerpMarketAbi__factory.connect(CONTRACT_ADDRESSES.perpMarket, wallet);
		const vaultMarketContract = VaultAbi__factory.connect(CONTRACT_ADDRESSES.vault, wallet);
		this.setContract({
			proxyContract,
			accountBalanceContract,
			clearingHouseContract,
			insuranceFundContract,
			perpMarketContract,
			vaultMarketContract,
		});
	};
	updateMarket = async () => {
		const { tradeStore, accountStore } = this.rootStore;
		const market = tradeStore.market;
		if (market == null || market.type === "spot") return;
		this.setAssetId0(market?.token0.assetId);
		this.setAssetId1(market?.token1.assetId);

		await this.initContracts();
		const promise = new Promise((resolve, reject) => {
			this.rejectUpdateStatePromise = reject;
			resolve(
				Promise.all([
					this.updateMaxValueForMarket(),
					// this.calcMaxPositionSize(clearingHouse, perpMarketAbi),
				]),
			);
		});

		promise
			.catch((v) => console.error(v))
			.finally(() => {
				this.setInitialized(true);
				this.setRejectUpdateStatePromise(undefined);
			});
	};
	updateMaxValueForMarket = async () => {
		const addressInput = this.rootStore.accountStore.addressInput;
		const baseAsset = { value: this.token0.assetId };
		if (addressInput == null) return;
		const result = await this.contracts?.clearingHouseContract.functions
			.get_max_abs_position_size(addressInput, baseAsset)
			.addContracts(Object.values(this.contracts))
			.simulate();
		if (result?.value != null) {
			const value = result.value;
			const short = new BN(value[0].toString());
			const long = new BN(value[1].toString());
			this.setMaxAbsPositionSize({ long, short });
		}
	};
	loading: boolean = false;
	setLoading = (l: boolean) => (this.loading = l);

	assetId0: string = TOKENS_BY_SYMBOL.UNI.assetId;
	setAssetId0 = (assetId: string) => (this.assetId0 = assetId);

	assetId1: string = TOKENS_BY_SYMBOL.USDC.assetId;
	setAssetId1 = (assetId: string) => (this.assetId1 = assetId);

	get token0() {
		return TOKENS_BY_ASSET_ID[this.assetId0];
	}

	get token1() {
		return TOKENS_BY_ASSET_ID[this.assetId1];
	}

	openOrder = async () => {
		const { accountStore, oracleStore } = this.rootStore;
		if (oracleStore.updateData == null) return;
		await accountStore.checkConnectionWithWallet();
		try {
			this.setLoading(true);
			const fee = await oracleStore.getPythFee();
			if (fee == null) return;
			const baseAsset = { value: this.token0.assetId };
			const price = this.price.toString();
			const size = { value: this.orderSize.toString(), negative: this.isShort };
			const result = await this.contracts?.clearingHouseContract.functions
				.open_order(baseAsset, size, price, oracleStore.updateData)
				.addContracts(Object.values(this.contracts))
				.callParams({ forward: { amount: fee ?? "", assetId: TOKENS_BY_SYMBOL.ETH.assetId } })
				.txParams({ gasPrice: 1 })
				.call();
		} catch (e) {
			console.log(e);
		} finally {
			this.setLoading(false);
		}
	};

	isShort: boolean = false;
	setIsShort = (v: boolean) => (this.isShort = v);

	orderSize: BN = BN.ZERO;
	setOrderSize = (v: BN, sync?: boolean) => {
		const max = this.maxPositionSize;
		if (max == null) return;
		v.gte(max) ? (this.orderSize = max) : (this.orderSize = v);
		if (this.price.gt(0) && sync) {
			const size = BN.formatUnits(v, this.token0.decimals);
			const price = BN.formatUnits(this.price, this.token1.decimals);
			const value = BN.parseUnits(size.times(price), this.token1.decimals);
			this.setOrderValue(value);
		}
	};

	get formattedOrderSize() {
		return BN.formatUnits(this.orderSize, this.token0.decimals).toFormat(2);
	}

	orderValue: BN = BN.ZERO;
	setOrderValue = (v: BN, sync?: boolean) => {
		this.orderValue = v;
		if (this.price.gt(0) && sync) {
			const value = BN.formatUnits(v, this.token1.decimals);
			const price = BN.formatUnits(this.price, this.token1.decimals);
			const size = BN.parseUnits(value.div(price), this.token0.decimals);
			this.setOrderSize(size);
		}
	};

	get formattedOrderValue() {
		return BN.formatUnits(this.orderValue, this.token1.decimals).toFormat(2);
	}

	price: BN = new BN(BN.parseUnits(27000, this.token1.decimals));
	setPrice = (v: BN, sync?: boolean) => {
		this.price = v;
		if (this.orderValue.gt(0) && sync) {
			const value = BN.formatUnits(this.orderValue, this.token1.decimals);
			const price = BN.formatUnits(v, this.token1.decimals);
			const size = BN.parseUnits(price.div(value), this.token0.decimals);
			this.setOrderSize(size);
		}
	};

	get leverageSize() {
		const { tradeStore } = this.rootStore;
		const size = BN.formatUnits(this.orderSize, this.token0.decimals);
		const price = BN.formatUnits(this.price, this.token1.decimals);
		const freeColl = BN.formatUnits(tradeStore.freeCollateral ?? 0, this.token0.decimals);
		return size.times(price.div(freeColl)).div(100);
	}

	get leveragePercent() {
		return this.orderSize.times(100).div(this.maxPositionSize).toNumber();
	}

	onLeverageClick = (leverage: number) => {
		const { tradeStore } = this.rootStore;
		const collateral = BN.formatUnits(tradeStore.freeCollateral ?? 0, this.token1.decimals);
		const value = BN.parseUnits(collateral.times(leverage).times(100), this.token1.decimals);
		this.setOrderValue(value, true);
	};
	onMaxClick = () => {
		const price = BN.formatUnits(this.price, this.token1.decimals);
		const val = BN.formatUnits(this.maxPositionSize, this.token0.decimals);
		const value = BN.parseUnits(val.times(price), this.token1.decimals);
		this.setOrderSize(this.maxPositionSize, true);
		this.setOrderValue(value);
	};

	get maxPositionSize() {
		const max = this.isShort ? this.maxAbsPositionSize?.short : this.maxAbsPositionSize?.long;
		return max == null ? BN.ZERO : max;
	}
}
