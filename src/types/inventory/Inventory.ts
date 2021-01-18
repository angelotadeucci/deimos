import { ChannelSession } from "../../network/sessions/ChannelSession";
import { ItemInventoryPacket } from "../../packets/ItemInventoryPacket";
import { Logger } from "../../tools/Logger";
import { InventoryTab } from "../InventoryTab";
import { Item } from "../item/Item";
import { Player } from "../player/Player";

interface ItemTuple {
    item1: BigInt;
    item2: number;
}

export class Inventory {

    public size: number;
    private player: Player; // TODO remove after clean up

    private items: Map<BigInt, Item> = new Map<BigInt, Item>(); // all inventory items regardless of tab
    private slotMaps: Map<number, BigInt>[]; // slot to Uid for each tab 

    public constructor(player: Player, size: number) {
        this.player = player;
        this.size = size;

        const maxTabs = Object.values(InventoryTab).length / 2;
        this.slotMaps = new Array<Map<number, BigInt>>(maxTabs + 1);
        for (let i = 0; i <= maxTabs; i++) {
            this.slotMaps[i] = new Map<number, BigInt>();
        }
    }

    public getItems(tab: InventoryTab): Array<Item> {
        const uids = Array.from(this.getSlots(tab).values());
        const items = new Array<Item>();
        for (let i = 0; i < uids.length; i++) {
            const item = this.items.get(uids[i]);
            if (item) {
                items.push(item);
            }
        }
        return items;
    }

    // TODO: precompute next free slot to avoid iteration on Add
    // TODO: Stack this.items when they are the same
    // Returns false if inventory is full
    public add(item: Item): boolean {
        // Item has a slot set, to: try use that slot
        if (item.slot >= 0) {
            if (!this.slotTaken(item, item.slot)) {
                this.addInternal(item);
                return true;
            }

            item.slot = -1; // Reset slot
        }

        for (let i = 0; i < this.size; i++) {
            if (this.slotTaken(item, i)) {
                continue;
            }
            item.slot = i;

            this.addInternal(item);
            return true;
        }
        return false;
    }

    // Returns false if item doesn't exist or removing more than available
    // TODO: fix return value here
    public remove(uid: BigInt, amount: number = -1): number {

        // Removing more than available
        const item = this.items.get(uid);
        if (!item || item.amount < amount) {
            return -1;
        }

        if (amount < 0 || item.amount == amount) { // Remove All
            const removedItem = this.removeInternalByUID(uid);

            if (!removedItem) {
                return -1;
            }

            removedItem.slot = -1;
            return 0;
        }

        const removedItem = item.trySplit(amount);

        if (removedItem) {
            return item.amount;
        }

        return -1;
    }

    // Replaces an existing item with an updated copy of itself
    public replace(item: Item): boolean {

        if (!this.items.has(item.uid)) {
            return false;
        }

        const replacedItem = this.removeInternalByUID(item.uid);

        if (!replacedItem) {
            return false;
        }

        item.slot = replacedItem.slot;
        this.addInternal(item);

        return true;
    }

    // Returns null if item doesn't exist
    // Returns the uid and slot of destItem (uid is 0 if empty)
    public move(uid: BigInt, dstSlot: number): ItemTuple | undefined {
        const srcItem = this.removeInternalByUID(uid);
        if (!srcItem) {
            return;
        }

        const srcSlot = srcItem.slot;
        // Move dstItem to srcSlot if removed
        const dstItem = this.removeInternalByTab(srcItem.inventoryTab, dstSlot);
        if (dstItem) {
            dstItem.slot = srcSlot;
            this.addInternal(dstItem);
        }

        // Move srcItem to dstSlot
        srcItem.slot = dstSlot;
        this.addInternal(srcItem);

        const tuple: ItemTuple = {
            item1: dstItem?.uid ?? BigInt(0),
            item2: srcSlot
        }

        return tuple;
    }

    public sort(tab: InventoryTab): void {
        // Get all this.items in tab and sort by Id
        const slots = this.getSlots(tab);
        const tabItems = this.getItems(tab);
        tabItems.sort((x, y) => x.id - y.id);

        // Update the slot mapping
        slots.clear();
        for (let i = 0; i < tabItems.length; i++) {
            tabItems[i].slot = i;
            slots.set(i, tabItems[i].uid);
        }
    }

    // This REQUIRES item.slot to be set appropriately
    private addInternal(item: Item): void {
        if (this.items.has(item.uid)) {
            Logger.log("Error adding an item that already exists");
        }

        this.items.set(item.uid, item);

        if (this.getSlots(item.inventoryTab).has(item.slot)) {
            Logger.log("Error adding item to slot that is already taken.");
        }

        this.getSlots(item.inventoryTab).set(item.slot, item.uid);
    }

    private removeInternalByUID(uid: BigInt): Item | undefined {
        const item = this.items.get(uid);

        if (!item) {
            return;
        }

        this.items.delete(uid);
        this.getSlots(item.inventoryTab).delete(item.slot);

        return item;
    }

    private removeInternalByTab(tab: InventoryTab, slot: number): Item | undefined {

        const uid = this.getSlots(tab).get(slot);

        if (!uid) {
            return;
        }

        return this.removeInternalByUID(uid);
    }

    private slotTaken(item: Item, slot: number = -1): boolean {
        return this.getSlots(item.inventoryTab).has(slot < 0 ? item.slot : slot);
    }

    private getSlots(tab: InventoryTab): Map<number, BigInt> {
        return this.slotMaps[tab];
    }

    // Adds item
    // TODO: consolidate methods and rename
    public add2(session: ChannelSession, item: Item, isNew: boolean): void {
        // Checks if item is stackable or not
        if (item.slotMax > 1) {
            for (const i of session.player.inventory.items.values()) {
                // Checks to see if item exists in database (dictionary)
                if (i.id != item.id || i.amount >= i.slotMax) {
                    continue;
                }
                // Updates inventory for item amount overflow
                if ((i.amount + item.amount) > i.slotMax) {
                    const added = i.slotMax - i.amount;
                    item.amount -= added;
                    i.amount = i.slotMax;
                    session.send(ItemInventoryPacket.update(i.uid, i.amount));
                    session.send(ItemInventoryPacket.markItemNew(i, added));
                }
                // Updates item amount
                else {
                    i.amount += item.amount;
                    session.send(ItemInventoryPacket.update(i.uid, i.amount));
                    session.send(ItemInventoryPacket.markItemNew(i, item.amount));
                    return;
                }
            }
        }
        session.player.inventory.add(item); // Adds item numbero numberernal database
        session.send(ItemInventoryPacket.add(item)); // Sends packet to add item clientside
        if (isNew) {
            session.send(ItemInventoryPacket.markItemNew(item, item.amount)); // Marks Item as New
        }
    }

    // Removes Item from inventory by reference
    // TODO: consolidate methods and rename
    public remove2(session: ChannelSession, uid: BigInt): void {
        session.player.inventory.remove(uid);
        session.send(ItemInventoryPacket.remove(uid));
    }

    // Picks up item
    public pickUp(session: ChannelSession, item: Item): void {
        session.player.inventory.add(item); // Adds item numbero numberernal database
        session.send(ItemInventoryPacket.add(item)); // Sends packet to add item clientside
    }

    // Drops item with option to drop bound items
    public dropItem(session: ChannelSession, uid: BigInt, amount: number, isbound: boolean): void {
        if (!isbound) // Drops Item
        {
            const remaining = session.player.inventory.remove(uid, amount); // Returns remaining amount of item
            if (remaining < 0) {
                return; // Removal failed
            }
            else if (remaining > 0) // Updates item
            {
                session.send(ItemInventoryPacket.update(uid, remaining));
            }
            else // Removes item
            {
                session.send(ItemInventoryPacket.remove(uid));
            }

            // TODO: Drops item onto floor
            // session.field.addItem(session, droppedItem);
        }
        else // Drops bound item.
        {
            // TODO: fix return value here
            const droppedItem = session.player.inventory.remove(uid);
            if (droppedItem != 0) {
                return; // Removal from inventory failed
            }
            session.send(ItemInventoryPacket.remove(uid));

            // TODO: Allow dropping bound items for now
            // session.field.addItem(session, droppedItem);
        }
    }

    public sortInventory(session: ChannelSession, tab: InventoryTab): void {
        this.sort(tab);
        session.send(ItemInventoryPacket.resetTab(tab));
        session.send(ItemInventoryPacket.loadItemsToTab(tab, this.getItems(tab)));
    }

    public loadInventoryTab(session: ChannelSession, tab: InventoryTab): void {
        session.send(ItemInventoryPacket.resetTab(tab));
        session.send(ItemInventoryPacket.loadTab(tab));
    }

    public moveItem(session: ChannelSession, uid: BigInt, dstSlot: number): void {
        const srcSlot = session.player.inventory.move(uid, dstSlot);

        if (srcSlot == null) {
            return;
        }

        session.send(ItemInventoryPacket.move(srcSlot.item1, srcSlot.item2, uid, dstSlot));
    }

    // Todo: implement when storage and trade is implemented
    public split(session: ChannelSession, item: Item): void {

    }

    // Updates item information
    public update(session: ChannelSession, uid: BigInt, amount: number): void {
        const item = session.player.inventory.items.get(uid);

        if (!item) {
            Logger.log("Item was null inside update");
            return;
        }

        if ((this.getItemAmount(session, uid) + amount) >= this.getItemMax(session, uid)) {
            item.amount = item.slotMax;
            session.send(ItemInventoryPacket.update(uid, item.slotMax));
        }

        item.amount = amount;
        session.send(ItemInventoryPacket.update(uid, amount));
    }

    private getItemAmount(session: ChannelSession, uid: BigInt): number {
        const item = session.player.inventory.items.get(uid);
        return item ? item.amount : -1;
    }

    private getItemMax(session: ChannelSession, uid: BigInt): number {
        const item = session.player.inventory.items.get(uid);
        return item ? item.slotMax : -1;
    }
}
