import { NOTICE, SFX } from "./config.js";
import * as Notice from "./notice.js";
import * as Watcher from "./watcher.js";
import { playSafe } from "./util.js";

/**
 * Counterplay.
 *
 * The pack has to be survivable or the escalation curve is just a countdown.
 * There are four ways down, in ascending order of cost:
 *
 *   daylight    — free, slow, and unavailable to anyone doing anything useful
 *   company     — another player or a villager nearby
 *   light       — torches you place as you dig
 *   the Kindler — fast, but it guts out if you rush it
 *
 * And one way to move the ratchet itself: the tallow candle. It is the only
 * effect in the pack that lowers the floor, which makes it the only way to
 * genuinely undo a bad night rather than wait one out.
 */

export function onItemUse(event) {
  const player = event.source;
  const item = event.itemStack;
  if (!player || !item || item.typeId !== "nx:tallow_candle") return;

  if (Notice.candleLit(player)) {
    try {
      player.onScreenDisplay.setActionBar("§8One is already burning.");
    } catch {
      /* ignore */
    }
    return;
  }

  Notice.lightCandle(player);
  Notice.add(player, -6);
  playSafe(player, SFX.KINDLE, { location: player.location, volume: 0.6, pitch: 1.5 });

  try {
    player.onScreenDisplay.setActionBar("§7The wick takes. Six minutes of quiet.");
  } catch {
    /* ignore */
  }

  // Consume one from the stack the player is holding.
  try {
    const equip = player.getComponent("minecraft:equippable");
    const slot = equip?.getEquipmentSlot("Mainhand");
    const held = slot?.getItem();
    if (held && held.typeId === "nx:tallow_candle") {
      if (held.amount > 1) {
        held.amount -= 1;
        slot.setItem(held);
      } else {
        slot.setItem(undefined);
      }
    }
  } catch {
    /* if the item cannot be consumed the effect still applies; not worth failing over */
  }
}

/**
 * `/scriptevent nx:state` — the only diagnostic, and it is deliberately blunt.
 * Showing the number permanently would defeat the entire design; showing it on
 * request is how you tune the pack.
 */
export function onScriptEvent(event) {
  const player = event.sourceEntity;
  if (!player || typeof player.onScreenDisplay === "undefined") return;

  if (event.id === "nx:state") {
    const n = Notice.get(player).toFixed(1);
    const f = Notice.getFloor(player).toFixed(1);
    const r = Watcher.permittedRadius(player, Watcher.stealthTier(player)).toFixed(1);
    player.sendMessage(
      `§7notice §f${n}§7/${NOTICE.MAX}  floor §f${f}  tier §f${Notice.tierIndex(player)}` +
        `  stealth §f${Watcher.stealthTier(player)}  permitted §f${r}m` +
        `  present §f${Watcher.isPresent(player) ? "yes" : "no"}`
    );
  } else if (event.id === "nx:set") {
    const value = Number.parseFloat(event.message);
    if (Number.isFinite(value)) {
      Notice.add(player, value - Notice.get(player));
      player.sendMessage(`§7notice set to §f${Notice.get(player).toFixed(1)}`);
    }
  }
}
