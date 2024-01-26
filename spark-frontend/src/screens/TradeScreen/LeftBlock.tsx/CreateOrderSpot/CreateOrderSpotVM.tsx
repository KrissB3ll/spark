import React, { PropsWithChildren, useMemo } from "react";
import { BigNumberish, ethers } from "ethers";
import { makeAutoObservable } from "mobx";

import SPOT_MARKET_ABI from "@src/abi/SPOT_MARKET_ABI";
import { CONTRACT_ADDRESSES, DEFAULT_DECIMALS, TOKENS_BY_SYMBOL } from "@src/constants";
import useVM from "@src/hooks/useVM";
import BN from "@src/utils/BN";
import { RootStore, useStores } from "@stores";

const ctx = React.createContext<CreateOrderSpotVM | null>(null);

export const CreateOrderSpotVMProvider: React.FC<PropsWithChildren> = ({ children }) => {
	const rootStore = useStores();
	const store = useMemo(() => new CreateOrderSpotVM(rootStore), [rootStore]);
	return <ctx.Provider value={store}>{children}</ctx.Provider>;
};

export const useCreateOrderSpotVM = () => useVM(ctx);

const HALF_GWEI = new BN(5 * 1e9); // 0.5

export enum ORDER_MODE {
	BUY,
	SELL,
}

class CreateOrderSpotVM {
	loading = false;

	mode: ORDER_MODE = ORDER_MODE.BUY;

	inputPrice: BN = BN.ZERO;
	inputAmount: BN = BN.ZERO;
	inputPercent: BN = BN.ZERO;
	inputTotal: BN = BN.ZERO;

	constructor(private rootStore: RootStore) {
		makeAutoObservable(this);
	}

	get canProceed() {
		return (
			this.rootStore.accountStore.provider &&
			this.inputAmount.gt(0) &&
			this.inputPrice.gt(0) &&
			this.inputTotal.gt(0) &&
			!this.inputTotalError
		);
	}

	get inputTotalError(): boolean {
		const { tradeStore, balanceStore } = this.rootStore;
		const balance = balanceStore.getBalance(tradeStore.market!.quoteToken.assetId);
		return balance ? this.inputTotal.gt(balance) : false;
	}

	get isSell(): boolean {
		return this.mode === ORDER_MODE.SELL;
	}

	setOrderMode = (mode: ORDER_MODE) => (this.mode = mode);

	onMaxClick = () => {
		const { tradeStore, balanceStore } = this.rootStore;

		const tokenId = this.isSell ? tradeStore.market!.baseToken.assetId : tradeStore.market!.quoteToken.assetId;

		let balance = balanceStore.getBalance(tokenId) ?? BN.ZERO;
		if (tokenId === TOKENS_BY_SYMBOL.ETH.assetId) {
			balance = balance.minus(HALF_GWEI);
		}

		this.setInputTotal(balance, true);
	};

	setInputPrice = (price: BN, sync?: boolean) => {
		const { tradeStore } = this.rootStore;

		this.inputPrice = price;
		if (price.eq(0)) {
			this.setInputTotal(BN.ZERO);
			return;
		}

		if (this.inputAmount.gt(0) && price.gt(0) && sync) {
			const formattedPrice = BN.formatUnits(price, DEFAULT_DECIMALS);
			const formattedAmount = BN.formatUnits(this.inputAmount, tradeStore.market!.baseToken.decimals);

			const total = BN.parseUnits(formattedAmount.times(formattedPrice), tradeStore.market!.quoteToken.decimals);
			this.setInputTotal(total);
		}
	};

	setInputAmount = (amount: BN, sync?: boolean) => {
		const { tradeStore, balanceStore } = this.rootStore;
		this.inputAmount = amount;

		if (this.inputPrice.gt(0) && amount.gt(0) && sync) {
			const formattedInputPrice = BN.formatUnits(this.inputPrice, DEFAULT_DECIMALS);
			const formattedAmount = BN.formatUnits(amount, tradeStore.market!.baseToken.decimals);

			const total = BN.parseUnits(formattedAmount.times(formattedInputPrice), tradeStore.market!.quoteToken.decimals);
			this.setInputTotal(total);

			const balance = balanceStore.getBalance(tradeStore.market!.quoteToken.assetId);
			if (!balance) return;

			const percentageOfTotal = total.times(100).div(balance);
			const inputPercent = percentageOfTotal.gt(100) ? 100 : +percentageOfTotal.toFormat(0);
			this.setInputPercent(inputPercent);
		}
	};

	setInputPercent = (value: number | number[]) => (this.inputPercent = new BN(value.toString()));

	setInputTotal = (total: BN, sync?: boolean) => {
		const { tradeStore, balanceStore } = this.rootStore;
		this.inputTotal = total;

		if (this.inputPrice.gt(0) && sync) {
			const formattedInputPrice = BN.formatUnits(this.inputPrice, DEFAULT_DECIMALS);
			const formattedTotal = BN.formatUnits(total, tradeStore.market!.quoteToken.decimals);

			const inputAmount = BN.parseUnits(formattedTotal.div(formattedInputPrice), tradeStore.market!.baseToken.decimals);
			this.setInputAmount(inputAmount);

			const balance = balanceStore.getBalance(tradeStore.market!.quoteToken.assetId);
			if (!balance) return;

			const percentageOfBalance = total.times(100).div(balance);
			const inputPercent = percentageOfBalance.gt(100) ? 100 : +percentageOfBalance.toFormat(0);
			this.setInputPercent(inputPercent);
		}
	};

	//todo починить
	createOrder = async () => {
		const { accountStore } = this.rootStore;

		if (!accountStore.signer || !this.rootStore.tradeStore.market) return;

		this.setLoading(true);

		const baseSize = this.isSell ? this.inputAmount.times(-1) : this.inputAmount;
		const baseToken = this.rootStore.tradeStore.market.baseToken.assetId;

		const contract = new ethers.Contract(CONTRACT_ADDRESSES.spotMarket, SPOT_MARKET_ABI, accountStore.signer);
		const transaction = await contract.openOrder(baseToken, baseSize.toString() as BigNumberish, this.inputPrice);
		await transaction.wait();
		//todo sync orderbook
		//todo notifications
		this.setLoading(false);
	};

	private setLoading = (l: boolean) => (this.loading = l);
}
