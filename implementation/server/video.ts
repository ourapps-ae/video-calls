export type VideoEnv = { LIVEKIT_URL?: string; LIVEKIT_API_KEY?: string; LIVEKIT_API_SECRET?: string; [k: string]: unknown };
export type VideoGrant = { url: string; token: string; room: string } | null;

const TOKEN_TTL_S = 6 * 60 * 60;

// Collected settings (`enabled`, `serviceUrl`) and the two secrets, resolved by the deployment from `keyReference` and
// `secretReference`, as the environment videoGrant and listRooms read. Empty (so grants are null) unless enabled and complete.
// `serviceUrl` is an http or https address; clients need the socket form, so https becomes wss and http becomes ws.
export type VideoSettings = { enabled?: boolean; serviceUrl?: string };
export type VideoSecrets = { apiKey?: string; apiSecret?: string };
export function videoEnvironment(settings: VideoSettings, secrets: VideoSecrets): VideoEnv {
  if (settings.enabled === false || !settings.serviceUrl || !secrets.apiKey || !secrets.apiSecret) return {};
  let address: URL;
  try { address = new URL(settings.serviceUrl); } catch { return {}; }
  if (!["http:", "https:"].includes(address.protocol) || address.username || address.password || address.search || address.hash) return {};
  address.protocol = address.protocol === "https:" ? "wss:" : "ws:";
  return { LIVEKIT_URL: address.href.replace(/\/+$/, ""), LIVEKIT_API_KEY: secrets.apiKey, LIVEKIT_API_SECRET: secrets.apiSecret };
}

export async function videoGrant(env: VideoEnv, tableId: string, playerId: string, name: string, now: number, publish: boolean, roomPrefix: string): Promise<VideoGrant> {
  if (!env.LIVEKIT_URL || !env.LIVEKIT_API_KEY || !env.LIVEKIT_API_SECRET) return null;
  const room = `${roomPrefix}${tableId}`;
  const iat = Math.floor(now / 1000);
  const payload = {
    iss: env.LIVEKIT_API_KEY, sub: playerId, name, iat, nbf: iat - 10, exp: iat + TOKEN_TTL_S,
    video: { room, roomJoin: true, roomCreate: true, canPublish: publish, canSubscribe: true, canPublishData: false },
  };
  try {
    const token = await signHs256({ alg: "HS256", typ: "JWT" }, payload, env.LIVEKIT_API_SECRET);
    return { url: env.LIVEKIT_URL, token, room };
  } catch {
    return null;
  }
}

export async function listRooms(env: VideoEnv, now: number, roomPrefix: string, fetcher: typeof fetch = fetch): Promise<{ room: string; participants: string[] }[] | null> {
  if (!env.LIVEKIT_URL || !env.LIVEKIT_API_KEY || !env.LIVEKIT_API_SECRET) return null;
  let base: string;
  try {
    const address = new URL(env.LIVEKIT_URL);
    if (address.protocol === "ws:") address.protocol = "http:";
    if (address.protocol === "wss:") address.protocol = "https:";
    if (!["http:", "https:"].includes(address.protocol) || address.username || address.password || address.search || address.hash) return null;
    base = address.href.replace(/\/+$/, "");
  } catch { return null; }
  const iat = Math.floor(now / 1000);
  const token = await signHs256({ alg: "HS256", typ: "JWT" }, { iss: env.LIVEKIT_API_KEY, iat, nbf: iat - 10, exp: iat + 300, video: { roomList: true, roomAdmin: true } }, env.LIVEKIT_API_SECRET);
  const call = async (method: string, body: object) => {
    const r = await fetcher(`${base}/twirp/livekit.RoomService/${method}`, { method: "POST", headers: { authorization: `Bearer ${token}`, "content-type": "application/json" }, body: JSON.stringify(body) });
    return await r.json() as Record<string, unknown>;
  };
  const rooms = (((await call("ListRooms", {})).rooms as { name: string }[] | undefined) ?? []).filter((r) => r.name.startsWith(roomPrefix));
  const out = [];
  for (const r of rooms) {
    const ps = ((await call("ListParticipants", { room: r.name })).participants as { identity: string; name?: string }[] | undefined) ?? [];
    out.push({ room: r.name, participants: ps.map((p) => p.name || p.identity) });
  }
  return out;
}

async function signHs256(header: object, payload: object, secret: string): Promise<string> {
  const enc = (o: object) => base64url(new TextEncoder().encode(JSON.stringify(o)));
  const data = `${enc(header)}.${enc(payload)}`;
  const key = await crypto.subtle.importKey("raw", new TextEncoder().encode(secret), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  const sig = await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(data));
  return `${data}.${base64url(new Uint8Array(sig))}`;
}

function base64url(bytes: Uint8Array): string {
  let s = "";
  for (let i = 0; i < bytes.length; i++) s += String.fromCharCode(bytes[i]);
  return btoa(s).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}
