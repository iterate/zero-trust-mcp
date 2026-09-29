import { z } from "zod";
import type { YotoClient } from "./client.js";
import { id } from "./media.js";

export const volumeLimit = z.number().int().min(0).max(16);
const clockTime = z.string().regex(/^(?:[01]\d|2[0-3]):[0-5]\d$/);
const colour = z.string().regex(/^#[0-9a-fA-F]{6}$/);
const value = z.string().min(1).max(256);
export const playerConfigSchema = z.strictObject({
  maxVolumeLimit: volumeLimit.optional(), nightMaxVolumeLimit: volumeLimit.optional(),
  dayTime: clockTime.optional(), nightTime: clockTime.optional(),
  headphonesVolumeLimited: z.boolean().optional(), btHeadphonesEnabled: z.boolean().optional(), repeatAll: z.boolean().optional(),
  bluetoothEnabled: z.enum(["0", "1"]).optional(), locale: value.optional(),
  ambientColour: colour.optional(), nightAmbientColour: colour.optional(),
  dayDisplayBrightness: value.optional(), nightDisplayBrightness: value.optional(), displayDimBrightness: value.optional(),
  displayDimTimeout: z.number().int().nonnegative().optional(), shutdownTimeout: z.number().int().nonnegative().optional(),
  hourFormat: z.enum(["12", "24"]).optional(), clockFace: value.optional(), volumeLevel: value.optional(),
  dayYotoDaily: value.optional(), dayYotoRadio: value.optional(), nightYotoDaily: value.optional(), nightYotoRadio: value.optional(),
});
export const settingsSchema = z.strictObject({ deviceId: id, name: z.string().trim().min(1).max(100).optional(), config: playerConfigSchema.optional() })
  .refine(v => !!v.name || (v.config !== undefined && Object.keys(v.config).length > 0), "Supply a name or at least one setting");
const configResponse = z.object({ device: z.object({ config: z.record(z.string(), z.unknown()) }).passthrough() });
export async function getPlayerConfig(client: YotoClient, deviceId: string) {
  const parsed = configResponse.safeParse(await client.request(`/device-v2/${id.parse(deviceId)}/config`));
  if (!parsed.success) throw new Error("Yoto returned an invalid player configuration");
  return parsed.data;
}
export async function updatePlayerConfig(client: YotoClient, input: z.infer<typeof settingsSchema>) {
  const value = settingsSchema.parse(input);
  const config = Object.fromEntries(Object.entries(value.config ?? {}).map(([key, item]) => [key, typeof item === "number" ? String(item) : item]));
  // Android sends partial config objects (e.g. repeatAll); never replay unrelated settings.
  const result = await client.request(`/device-v2/${value.deviceId}/config`, {
    ...(value.name ? { name: value.name } : {}), ...(Object.keys(config).length ? { config } : {}),
  }, "PUT", true);
  if (result !== null && !z.object({ status: z.literal("ok") }).safeParse(result).success) {
    throw new Error("Yoto did not confirm the config update. Read get_player_config before retrying.");
  }
  let current: Awaited<ReturnType<typeof getPlayerConfig>>;
  try { current = await getPlayerConfig(client, value.deviceId); }
  catch { return { accepted: true, verified: false, deviceId: value.deviceId, message: "Update accepted but read-back failed. Use get_player_config before retrying." }; }
  const verified = Object.entries(config).every(([key, item]) => current.device.config[key] === item) && (!value.name || current.device.name === value.name);
  return { accepted: true, verified, deviceId: value.deviceId, ...current,
    message: verified ? "Changes are stored in Yoto's configuration. An offline player may apply them when it reconnects." : "Yoto accepted the update, but read-back does not yet match. Check get_player_config before retrying." };
}
