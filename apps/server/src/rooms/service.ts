import {
  DEFAULT_ROOM_ID,
  defaultRoom,
  type Room,
  RoomSchema,
  validateRoom,
} from '@deskhaven/shared';
import { eq } from 'drizzle-orm';
import type { AgentService } from '../agents/service.js';
import type { Db } from '../db/client.js';
import { rooms as roomsTable } from '../db/schema.js';
import type { WsHub } from '../ws/hub.js';

/** Persisted room layouts. The data model allows several rooms; the UI uses the lobby for now. */
export class RoomService {
  constructor(
    private readonly db: Db,
    private readonly hub: WsHub,
    private readonly agents: () => AgentService,
  ) {
    if (!this.get(DEFAULT_ROOM_ID)) this.write(defaultRoom(), false);
  }

  list(): Room[] {
    return this.db
      .select()
      .from(roomsTable)
      .all()
      .map((r) => RoomSchema.parse(JSON.parse(r.json)));
  }

  get(id: string): Room | undefined {
    const row = this.db.select().from(roomsTable).where(eq(roomsTable.id, id)).get();
    return row ? RoomSchema.parse(JSON.parse(row.json)) : undefined;
  }

  /** Validates and replaces a layout. Agents whose desk disappeared lose their desk assignment. */
  save(input: unknown): Room {
    const room = RoomSchema.parse(input);
    const problems = validateRoom(room);
    if (problems.length) throw new Error(`Invalid layout: ${problems.join('; ')}`);
    this.write({ ...room, updatedAt: Date.now() }, true);
    const desks = new Set(room.furniture.filter((f) => f.kind === 'desk').map((f) => f.id));
    for (const a of this.agents().list()) {
      if (a.roomId === room.id && a.deskId && !desks.has(a.deskId))
        this.agents().patch(a.id, (x) => ({ ...x, deskId: null }));
    }
    return room;
  }

  reset(id: string): Room {
    if (id !== DEFAULT_ROOM_ID) throw new Error('only the lobby has a shipped default');
    const room = defaultRoom();
    this.write(room, true);
    return room;
  }

  private write(room: Room, broadcast: boolean): void {
    const json = JSON.stringify(room);
    this.db
      .insert(roomsTable)
      .values({ id: room.id, json, updatedAt: room.updatedAt })
      .onConflictDoUpdate({ target: roomsTable.id, set: { json, updatedAt: room.updatedAt } })
      .run();
    if (broadcast) this.hub.broadcast({ type: 'room_updated', room });
  }
}
