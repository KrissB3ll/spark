import { makeAutoObservable } from "mobx";
import RootStore from "@stores/RootStore";
import { CONTRACT_ADDRESSES, IToken, TOKENS_BY_SYMBOL } from "@src/constants";
import BN from "@src/utils/BN";
import { VaultAbi__factory } from "@src/contracts";

export interface IMarket {
	token0: IToken;
	token1: IToken;
	type: string;
	leverage?: number;
	price?: BN;
	change24?: BN;
	symbol: string;
}

//todo implement service for getting markets stats
//todo implement service file for getting data from indexer
export interface ISerializedTradeStore {
	favMarkets: string | null;
}

const spotMarketsConfig = [{ token0: TOKENS_BY_SYMBOL.UNI, token1: TOKENS_BY_SYMBOL.USDC }].map((v) => ({
	...v,
	symbol: `${v.token0.symbol}-${v.token1.symbol}`,
	type: "spot",
	price: new BN(10000),
	change24: new BN(10000),
}));
const perpMarketsConfig = [
	{ token0: TOKENS_BY_SYMBOL.BTC, token1: TOKENS_BY_SYMBOL.USDC, leverage: 10 },
	{ token0: TOKENS_BY_SYMBOL.ETH, token1: TOKENS_BY_SYMBOL.USDC, leverage: 10 },
	{ token0: TOKENS_BY_SYMBOL.UNI, token1: TOKENS_BY_SYMBOL.USDC, leverage: 10 },
].map((v) => ({
	...v,
	symbol: `${v.token0.symbol}-PERP`,
	type: "perp",
	price: new BN(10000),
	change24: new BN(10000),
}));

class TradeStore {
	public rootStore: RootStore;

	constructor(rootStore: RootStore, initState?: ISerializedTradeStore) {
		this.rootStore = rootStore;
		makeAutoObservable(this);
		this.setSpotMarkets(spotMarketsConfig);
		this.setPerpMarkets(perpMarketsConfig);

		if (initState != null) {
			const markets = initState.favMarkets ?? "";
			this.setFavMarkets(markets.split(","));
		}
	}

	freeCollateral: BN | null = null;
	setFreeCollateral = (v: BN | null) => (this.freeCollateral = v);

	marketSymbol: string | null = null;
	setMarketSymbol = (v: string) => (this.marketSymbol = v);

	marketsConfig: Record<string, IMarket> = [...spotMarketsConfig, ...perpMarketsConfig].reduce(
		(acc, item) => {
			acc[item.symbol] = item;
			return acc;
		},
		{} as Record<string, IMarket>,
	);
	loading: boolean = false;
	private _setLoading = (l: boolean) => (this.loading = l);

	spotMarkets: IMarket[] = [];
	private setSpotMarkets = (v: IMarket[]) => (this.spotMarkets = v);

	perpMarkets: IMarket[] = [];
	private setPerpMarkets = (v: IMarket[]) => (this.perpMarkets = v);

	favMarkets: string[] = [];
	private setFavMarkets = (v: string[]) => (this.favMarkets = v);

	serialize = (): ISerializedTradeStore => ({
		favMarkets: this.favMarkets.join(","),
	});
	addToFav = (marketId: string) => {
		if (!this.favMarkets.includes(marketId)) {
			this.setFavMarkets([...this.favMarkets, marketId]);
		}
		console.log(this.favMarkets);
	};
	removeFromFav = (marketId: string) => {
		const index = this.favMarkets.indexOf(marketId);
		index !== -1 && this.favMarkets.splice(index, 1);
	};

	get defaultMarketSymbol() {
		return this.spotMarkets[0].symbol;
	}

	get market() {
		return this.marketSymbol == null ? null : this.marketsConfig[this.marketSymbol];
	}

	get isMarketPerp() {
		return this.marketSymbol == null ? false : this.marketsConfig[this.marketSymbol].type === "perp";
	}

	marketSelectionOpened: boolean = false;
	setMarketSelectionOpened = (s: boolean) => (this.marketSelectionOpened = s);

	deposit = async (amount: BN) => {
		const { accountStore, notificationStore } = this.rootStore;
		try {
			this._setLoading(true);
			const vault = CONTRACT_ADDRESSES.vault;
			const wallet = await accountStore.getWallet();
			if (wallet == null) return;
			const vaultContract = VaultAbi__factory.connect(vault, wallet);

			const { transactionResult } = await vaultContract.functions
				.deposit_collateral()
				.callParams({
					forward: { amount: amount.toString(), assetId: TOKENS_BY_SYMBOL.USDC.assetId },
				})
				.txParams({ gasPrice: 1 })
				.call();
			if (transactionResult != null) {
				this.notifyThatActionIsSuccessful(`You have successfully deposited USDC`);
			}
			await this.rootStore.accountStore.updateAccountBalances();
		} catch (e) {
			const errorText = e?.toString();
			console.log(errorText);
			this.notifyError(errorText ?? "", { type: "error" });
		} finally {
			this._setLoading(false);
		}
	};
	withdraw = async (amount: BN) => {
		//todo check if user has enought of USDC
		const { accountStore, notificationStore } = this.rootStore;
		try {
			this._setLoading(true);
			const vault = CONTRACT_ADDRESSES.vault;
			const wallet = await accountStore.getWallet();
			if (wallet == null) return;
			const vaultContract = VaultAbi__factory.connect(vault, wallet);
			const userAddress = wallet.address.toB256();
			//todo make request to pyth
			const priceUpdateData = {} as any;

			const { transactionResult } = await vaultContract.functions
				//amount and update_data
				.withdraw_collateral(amount.toString(), priceUpdateData)
				.txParams({ gasPrice: 1 })
				.call();
			if (transactionResult != null) {
				this.notifyThatActionIsSuccessful(`You have successfully deposited USDC`);
			}
			await this.rootStore.accountStore.updateAccountBalances();
		} catch (e) {
			const errorText = e?.toString();
			console.log(errorText);
			this.notifyError(errorText ?? "", { type: "error" });
		} finally {
			this._setLoading(false);
		}
	};

	/////////////get values
	getFreeCollateral = async () => {
		this.setFreeCollateral(BN.ZERO);
	};
	notifyThatActionIsSuccessful = (title: string, txId?: string) => {
		this.rootStore.notificationStore.toast(title, {
			type: "success",
		});
	};
	notifyError = (title: string, error: any) => {
		console.error(error);
		this.rootStore.notificationStore.toast(title, {
			type: "error",
		});
	};
}

export default TradeStore;
