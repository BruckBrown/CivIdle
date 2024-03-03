import { SmoothGraphics } from "@pixi/graphics-smooth";
import type { FederatedPointerEvent, IPointData } from "pixi.js";
import { BitmapText, Container, LINE_CAP, LINE_JOIN, Sprite } from "pixi.js";
import WorldMap from "../../../shared/definitions/WorldMap.json";
import { getGameOptions } from "../../../shared/logic/GameStateLogic";
import { isTileReserved } from "../../../shared/logic/PlayerTradeLogic";
import { MAP_MAX_X, MAP_MAX_Y, type IClientMapEntry } from "../../../shared/utilities/Database";
import {
   drawDashedLine,
   forEach,
   formatPercent,
   mapSafeAdd,
   safeParseInt,
   xyToPoint,
} from "../../../shared/utilities/Helper";
import type { Disposable } from "../../../shared/utilities/TypedEvent";
import { OnPlayerMapMessage, OnTradeChanged, getPlayerMap, getTrades } from "../rpc/RPCClient";
import { PlayerMapPage } from "../ui/PlayerMapPage";
import { ViewportScene } from "../utilities/SceneManager";
import { Singleton } from "../utilities/Singleton";
import { Fonts } from "../visuals/Fonts";
import { findPath, getMyMapXy } from "./PathFinder";

let viewportCenter: IPointData | null = null;
let viewportZoom: number | null = null;

const GridSize = 100;

export class PlayerMapScene extends ViewportScene {
   private _width!: number;
   private _height!: number;
   private _selectedGraphics!: SmoothGraphics;
   private _tiles = new Map<string, Container>();
   private _listeners: Disposable[] = [];
   private _path!: SmoothGraphics;
   private _idToTradeCount = new Map<string, number>();
   private _idToTile = new Map<string, string>();
   private _dirtyTiles = new Set<string>();

   override onLoad(): void {
      const { app, textures } = this.context;
      this._width = MAP_MAX_X * GridSize;
      this._height = MAP_MAX_Y * GridSize;

      const minZoom = Math.max(app.screen.width / this._width, app.screen.height / this._height);
      this.viewport.setWorldSize(this._width, this._height);
      this.viewport.setZoomRange(minZoom, 1);

      app.renderer.background.color = 0x2980b9;

      // Assets.load<Texture>("/World.png").then((texture) => {
      //    const sprite = this.viewport.addChild(new Sprite(texture));
      //    sprite.anchor.set(0.5, 0.5);
      //    sprite.position.set(this._width / 2, this._height / 2);
      //    sprite.scale.set(11);
      //    sprite.alpha = 0.5;

      //    const pixels: Uint8Array = app.renderer.plugins.extract.pixels(sprite);
      //    const map: Record<string, true> = {};
      //    for (let x = 0; x <= MaxX; x++) {
      //       for (let y = 0; y <= MaxY; y++) {
      //          const pos = new Vector2((x * GridSize + 0.5 * GridSize) / 11, (y * GridSize + 0.5 * GridSize) / 11);
      //          const ind = Math.round(pos.x) + Math.round(pos.y) * texture.width;
      //          if (pixels[ind * 4 + 3] > 0) {
      //             map[`${x},${y + 3}`] = true;
      //          }
      //       }
      //    }
      //    forEach(map, (xy) => {
      //       const point = xyToPoint(xy);
      //       const sprite = this.viewport.addChild(new Sprite(this.context.textures["100x100"]));
      //       sprite.position.set(point.x * GridSize, point.y * GridSize);
      //    });
      //    navigator.clipboard.writeText(JSON.stringify(map));
      //    sprite.visible = false;
      // });

      forEach(WorldMap, (xy) => {
         const point = xyToPoint(xy);
         const sprite = this.viewport.addChild(new Sprite(this.context.textures["100x100"]));
         sprite.tint = 0x3498db;
         sprite.position.set(point.x * GridSize, point.y * GridSize);
      });

      const graphics = this.viewport.addChild(new SmoothGraphics()).lineStyle({
         color: 0xffffff,
         width: 2,
         cap: LINE_CAP.ROUND,
         join: LINE_JOIN.ROUND,
         alignment: 0.5,
      });
      graphics.alpha = 0.25;

      for (let x = 0; x <= MAP_MAX_X; x++) {
         graphics.moveTo(x * GridSize, 0);
         graphics.lineTo(x * GridSize, MAP_MAX_Y * GridSize);
      }

      for (let y = 0; y <= MAP_MAX_Y; y++) {
         graphics.moveTo(0, y * GridSize);
         graphics.lineTo(MAP_MAX_X * GridSize, y * GridSize);
      }

      getTrades().forEach((t) => {
         mapSafeAdd(this._idToTradeCount, t.fromId, 1);
      });

      this._listeners.push(
         OnTradeChanged.on((trades) => {
            const old = Array.from(this._idToTradeCount.keys());
            this._idToTradeCount.clear();

            trades.forEach((t) => {
               mapSafeAdd(this._idToTradeCount, t.fromId, 1);
               this.markDirtyById(t.fromId);
            });
            old.forEach((id) => {
               if (!this._idToTradeCount.has(id)) {
                  this.markDirtyById(id);
               }
            });
            this._dirtyTiles.forEach((tile) => {
               const entry = getPlayerMap().get(tile);
               if (entry) {
                  this.drawTile(tile, entry);
               }
            });
            this._dirtyTiles.clear();
         }),
      );

      getPlayerMap().forEach((entry, xy) => {
         this.drawTile(xy, entry);
      });

      this._listeners.push(
         OnPlayerMapMessage.on((message) => {
            if (message.remove) {
               message.remove.forEach((xy) => {
                  const id = getPlayerMap().get(xy)?.userId;
                  if (id) {
                     this._idToTile.delete(id);
                  }
                  this._tiles.get(xy)?.destroy({ children: true });
                  this._tiles.delete(xy);
               });
            }
            if (message.upsert) {
               forEach(message.upsert, (xy, entry) => {
                  this.drawTile(xy, entry);
               });
            }
         }),
      );

      this._selectedGraphics = this.viewport.addChild(new SmoothGraphics());
      this._path = this.viewport.addChild(new SmoothGraphics());

      this.viewport.on("clicked", (e: FederatedPointerEvent) => {
         if (e.button === 2) {
            return;
         }
         const pos = this.viewport.screenToWorld(e);
         const tileX = Math.floor(pos.x / GridSize);
         const tileY = Math.floor(pos.y / GridSize);
         this.selectTile(tileX, tileY);
      });

      if (!viewportZoom) {
         viewportZoom = (minZoom + 1) / 2;
      }

      const xy = getMyMapXy();
      if (xy) {
         const point = xyToPoint(xy);
         this.selectTile(point.x, point.y);
         if (!viewportCenter) {
            viewportCenter = this.tileToPosition(point);
         }
      } else {
         this.selectTile(100, 50);
         if (!viewportCenter) {
            viewportCenter = this.tileToPosition({ x: 100, y: 50 });
         }
      }

      this.viewport.zoom = viewportZoom;
      this.viewport.center = viewportCenter;

      this.viewport.on("moved", () => {
         viewportCenter = this.viewport.center;
         viewportZoom = this.viewport.zoom;
      });
   }

   private markDirtyById(userId: string): void {
      const tile = this._idToTile.get(userId);
      if (tile) {
         this._dirtyTiles.add(tile);
      }
   }

   private tileToPosition(tile: IPointData): IPointData {
      return { x: (tile.x + 0.5) * GridSize, y: (tile.y + 0.5) * GridSize };
   }

   public drawPath(path: IPointData[]): void {
      this._path.clear().lineStyle({
         color: 0xffff99,
         width: 4,
         cap: LINE_CAP.ROUND,
         join: LINE_JOIN.ROUND,
         alignment: 0.5,
      });
      this._path.alpha = 0.5;
      let count = 0;
      path.forEach((point, idx) => {
         const pos = this.tileToPosition(point);
         if (idx === 0) {
            this._path.moveTo(pos.x, pos.y);
         } else {
            count = drawDashedLine(this._path, this.tileToPosition(path[idx - 1]), pos, count, 5, 10);
         }
      });
   }

   public clearPath() {
      this._path.clear();
   }

   private selectTile(tileX: number, tileY: number) {
      const x = tileX * GridSize;
      const y = tileY * GridSize;

      this._selectedGraphics.clear();
      this._selectedGraphics
         .lineStyle({
            alpha: 0.75,
            color: 0xffff99,
            width: 2,
            cap: LINE_CAP.ROUND,
            join: LINE_JOIN.ROUND,
            alignment: 0.5,
         })
         .moveTo(x, y)
         .lineTo(x + GridSize, y)
         .lineTo(x + GridSize, y + GridSize)
         .lineTo(x, y + GridSize)
         .lineTo(x, y);

      const myXy = getMyMapXy();
      const map = getPlayerMap();

      if (myXy && map.has(`${tileX},${tileY}`)) {
         const path = findPath(xyToPoint(myXy), { x: tileX, y: tileY });
         this.drawPath(path);
      } else {
         this.clearPath();
      }

      Singleton().routeTo(PlayerMapPage, { xy: `${tileX},${tileY}` });
   }

   private drawTile(xy: string, entry: IClientMapEntry) {
      const { textures } = this.context;
      const [x, y] = xy.split(",").map((x) => safeParseInt(x));
      const container = this.viewport.addChild(new Container());
      this._tiles.get(xy)?.destroy({ children: true });
      this._tiles.set(xy, container);
      this._idToTile.set(entry.userId, xy);

      const isMyself = entry.userId === getGameOptions().id;
      const isReserved = isTileReserved(entry);

      const flag = container.addChild(new Sprite(textures[`Flag_${entry.flag.toUpperCase()}`]));
      flag.anchor.set(0.5, 0.5);
      flag.position.set(x * GridSize + 0.5 * GridSize, y * GridSize + 0.5 * GridSize - 24);
      flag.alpha = isReserved ? 1 : 0.5;

      const count = this._idToTradeCount.get(entry.userId);
      if (count) {
         const bg = container.addChild(new Sprite(textures.circle_25));
         bg.anchor.set(0.5, 0.5);
         bg.tint = 0xe74c3c;
         bg.position.set(x * GridSize + 0.9 * GridSize, y * GridSize + 0.12 * GridSize);

         const tradeCount = container.addChild(
            new BitmapText(String(count), {
               fontName: Fonts.Cabin,
               fontSize: 20,
               tint: 0xffffff,
            }),
         );
         tradeCount.anchor.set(0.5, 0.5);
         tradeCount.position.set(x * GridSize + 0.9 * GridSize, y * GridSize + 0.1 * GridSize);
      }

      const handle = container.addChild(
         new BitmapText(entry.handle, {
            fontName: Fonts.Cabin,
            fontSize: 16,
            tint: isMyself ? 0xffeaa7 : 0xffffff,
         }),
      );

      while (handle.width > GridSize - 10) {
         handle.fontSize--;
      }

      handle.anchor.set(0.5, 0.5);
      handle.position.set(x * GridSize + 0.5 * GridSize, y * GridSize + 0.5 * GridSize);
      handle.alpha = isReserved ? 1 : 0.5;

      const tariff = container.addChild(
         new BitmapText(formatPercent(entry.tariffRate), {
            fontName: Fonts.Cabin,
            fontSize: 20,
            tint: isMyself ? 0xffeaa7 : 0xffffff,
         }),
      );
      tariff.anchor.set(0.5, 0.5);
      tariff.position.set(x * GridSize + 0.5 * GridSize, y * GridSize + 0.5 * GridSize + 20);
      tariff.alpha = isReserved ? 1 : 0.5;
   }

   override onDestroy(): void {
      this._listeners.forEach((l) => l.dispose());
   }
}
