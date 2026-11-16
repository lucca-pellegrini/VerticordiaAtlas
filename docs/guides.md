# Verticordia Atlas Guide Format (`v: 1`)

A **Guide** in Verticordia Atlas is a recommended, linear route through a game, organized into ordered **sections** and **steps**. Guides are pure data (`docs/guide.schema.json`) validated by `cleanGuide()` in `src/shared/guide.ts` and evaluated against a player's profile by `deriveGuideView()` in `src/shared/guide-progress.ts`.

## Core Principles

1. **Guides Are Data, Not Programs**: Authors populate structured fields. All completion, visibility, and navigation rules live in the application.
2. **Linear but Forgiving**: A guide is a single ordered sequence, never a branching graph. Players can complete steps in any order; marker-bound steps derive their completion directly from the profile's found markers (`state.found`).
3. **Layered Richness**: Every step is valid with just an `id`, `kind`, and `title` (Level 0), and can be progressively enriched with a single target (Level 1), multiple targets (Level 2), exploration zones with exceptions (Level 3), and questline/variant metadata (Level 4).
4. **Content vs. Progress**: Guide definitions (`Guide`) belong to a game (`game`) and carry no player progress. Player progress (`GuideProgress`) lives inside each `Profile` (`profile.guides[guideId]`).

---

## Field Reference

### `Guide` (root object)

| Field         | Type             | Required | Description                                                                |
| ------------- | ---------------- | -------- | -------------------------------------------------------------------------- |
| `v`           | `1`              | Yes      | Schema version (`1`). Versions `> 1` are rejected with an upgrade message. |
| `id`          | `string`         | Yes      | Stable guide ID matching `/^[A-Za-z0-9_-]{4,24}$/`.                        |
| `game`        | `string`         | Yes      | Game slug/ID matching `/^[A-Za-z0-9._-]{1,80}$/`.                          |
| `title`       | `string`         | Yes      | Plain-text title (1–120 characters).                                       |
| `description` | `string`         | No       | Short Markdown overview (up to 2,000 characters).                          |
| `author`      | `string`         | No       | Free-text author credit (up to 120 characters).                            |
| `credits`     | `string`         | No       | Free-text sources and acknowledgements (up to 1,000 characters).           |
| `variants`    | `GuideVariant[]` | No       | Up to 8 variant dimensions (e.g. difficulty, faction).                     |
| `sections`    | `GuideSection[]` | Yes      | 1 to 300 ordered sections.                                                 |
| `created`     | `number`         | Yes      | Creation timestamp in milliseconds since Unix epoch.                       |
| `updated`     | `number`         | Yes      | Last-modified timestamp in milliseconds since Unix epoch.                  |

### `GuideVariant`

| Field     | Type              | Required | Description                                                                   |
| --------- | ----------------- | -------- | ----------------------------------------------------------------------------- |
| `id`      | `string`          | Yes      | Variant ID matching `/^[a-z0-9-]{1,40}$/`.                                    |
| `label`   | `string`          | Yes      | Human-readable label (up to 60 characters).                                   |
| `options` | `{ id, label }[]` | Yes      | 2 to 8 options (`id` matching `/^[a-z0-9-]{1,40}$/`, `label` up to 60 chars). |
| `default` | `string`          | Yes      | Option `id` selected by default.                                              |

### `GuideSection`

| Field      | Type          | Required | Description                                                                  |
| ---------- | ------------- | -------- | ---------------------------------------------------------------------------- |
| `id`       | `string`      | Yes      | Stable section ID matching `/^[A-Za-z0-9_-]{1,40}$/`.                        |
| `title`    | `string`      | Yes      | Plain-text section heading (1–120 characters).                               |
| `notes`    | `string`      | No       | Markdown notes for the section (up to 5,000 characters).                     |
| `level`    | `string`      | No       | Recommended level or tier, e.g. `"50-55"` (up to 40 characters).             |
| `gate`     | `string`      | No       | Plain-text prerequisite note (up to 500 characters).                         |
| `after`    | `string`      | No       | Plain-text note describing world changes after completion (up to 500 chars). |
| `optional` | `boolean`     | No       | When `true`, every step in this section is treated as optional.              |
| `steps`    | `GuideStep[]` | Yes      | Ordered steps within the section (total steps across the guide ≤ 2,000).     |

### `GuideStep`

| Field         | Type                             | Required | Description                                                                                         |
| ------------- | -------------------------------- | -------- | --------------------------------------------------------------------------------------------------- |
| `id`          | `string`                         | Yes      | Stable step ID matching `/^[A-Za-z0-9_-]{1,40}$/`.                                                  |
| `kind`        | `"task" \| "waypoint" \| "info"` | Yes      | `"task"` is counted and completable; `"waypoint"` is navigation only; `"info"` is knowledge only.   |
| `title`       | `string`                         | Yes      | Plain-text step summary (1–120 characters).                                                         |
| `notes`       | `string`                         | No       | Markdown details (up to 5,000 characters).                                                          |
| `targets`     | `GuideTarget[]`                  | No       | Up to 100 official marker or coordinate point targets.                                              |
| `place`       | `string`                         | No       | Human-readable location name when inside a sub-area (up to 120 characters).                         |
| `samePlace`   | `boolean`                        | No       | Inherits `place` from the preceding step in guide order.                                            |
| `reward`      | `string`                         | No       | Plain-text reward summary (up to 500 characters).                                                   |
| `consequence` | `string`                         | No       | Plain-text warning or world-state consequence (up to 1,000 characters).                             |
| `optional`    | `boolean`                        | No       | Marks the step as optional for required-completion tallies.                                         |
| `missable`    | `boolean`                        | No       | Highlights that this step can be permanently missed.                                                |
| `thread`      | `string`                         | No       | Questline or storyline tag matching `/^[^\r\n]{1,40}$/`.                                            |
| `only`        | `Record<string, string[]>`       | No       | Variant filter mapping `variantId -> allowedOptionIds[]`. Multiple keys combine with logical `AND`. |
| `links`       | `{ url, label? }[]`              | No       | Up to 5 external `http:` or `https:` links (`label` up to 80 characters).                           |
| `zone`        | `GuideZone`                      | No       | Exploration region or polygon with optional `avoid` exceptions.                                     |

### `GuideTarget`

Each target is either a bound official marker or a map coordinate point:

- **Marker target**: `{ "kind": "marker", "marker": <positive integer id>, "optional"?: boolean, "label"?: string, "snapshot"?: { "title": string, "cat"?: string, "lat": number, "lng": number, "map": string } }`
    - Must reference an official game marker (`marker > 0`), never a profile-local user marker.
    - If `snapshot` is provided and the marker is later removed from map data, the step degrades gracefully to the snapshot's coordinates.
- **Point target**: `{ "kind": "point", "point": { "lat": number, "lng": number, "map": string }, "optional"?: boolean, "label"?: string, "snapshot"?: ... }`

### `GuideZone`

| Field     | Type                            | Required | Description                                                                    |
| --------- | ------------------------------- | -------- | ------------------------------------------------------------------------------ |
| `map`     | `string`                        | Yes      | Map slug where the zone is located.                                            |
| `region`  | `number`                        | Cond.    | Official region ID (`> 0`). At least one of `region` or `polygon` is required. |
| `polygon` | `{ lng, lat }[]`                | Cond.    | Author-drawn polygon (3 to 500 finite vertices).                               |
| `avoid`   | `{ marker?, polygon?, note }[]` | No       | Up to 30 hazard/spoiler exceptions inside the zone (`note` up to 240 chars).   |

---

## Limits Summary

| Limit Constant                                             | Value       | Meaning                                              |
| ---------------------------------------------------------- | ----------- | ---------------------------------------------------- |
| `MAX_GUIDE_BYTES`                                          | `1,500,000` | Maximum UTF-8 byte length of a serialized guide JSON |
| `MAX_GUIDE_STEPS`                                          | `2,000`     | Maximum total steps across all sections              |
| `MAX_GUIDE_SECTIONS`                                       | `300`       | Maximum sections per guide                           |
| `MAX_STEP_TARGETS`                                         | `100`       | Maximum targets per step                             |
| `MAX_GUIDE_VARIANTS`                                       | `8`         | Maximum variants per guide                           |
| `MAX_VARIANT_OPTIONS`                                      | `8`         | Maximum options per variant (minimum `2`)            |
| `MAX_STEP_LINKS`                                           | `5`         | Maximum external `http(s)` links per step            |
| `MAX_ZONE_AVOID`                                           | `30`        | Maximum `avoid` entries per zone                     |
| `MAX_POLYGON_POINTS`                                       | `500`       | Maximum vertices per polygon                         |
| `MAX_GUIDE_TITLE` / `MAX_SECTION_TITLE` / `MAX_STEP_TITLE` | `120`       | Maximum title length                                 |
| `MAX_NOTES`                                                | `5,000`     | Maximum Markdown notes length on a section or step   |
| `MAX_DESCRIPTION`                                          | `2,000`     | Maximum guide description length                     |
| `MAX_CONSEQUENCE`                                          | `1,000`     | Maximum step consequence length                      |
| `MAX_REWARD`                                               | `500`       | Maximum step reward length                           |
| `MAX_PLACE`                                                | `120`       | Maximum step place length                            |
| `MAX_THREAD`                                               | `40`        | Maximum step thread tag length                       |
| `MAX_LINK_LABEL`                                           | `80`        | Maximum external link label length                   |

---

## Worked Examples

### Example 1: Flat Checklist with Bound Markers (Levels 0 & 1)

```json
{
	"v": 1,
	"id": "sunlit-checklist",
	"game": "sunlit-reach",
	"title": "Starter Valley Checklist",
	"sections": [
		{
			"id": "sec-dawnvale",
			"title": "Dawnvale",
			"steps": [
				{
					"id": "st-talk-elder",
					"kind": "task",
					"title": "Speak with the Camp Elder by the watchfire",
					"place": "Dawnvale Camp",
					"reward": "Brass Compass"
				},
				{
					"id": "st-waystone-1",
					"kind": "task",
					"title": "Attune the North Waystone",
					"targets": [{ "kind": "marker", "marker": 1001 }]
				}
			]
		}
	],
	"created": 1760000000000,
	"updated": 1760000000000
}
```

### Example 2: Multi-Target Sweep with Shared Places & Info Step (Levels 2 & 3)

```json
{
	"v": 1,
	"id": "cavern-sweep-01",
	"game": "sunlit-reach",
	"title": "Echoing Cavern Sweep",
	"sections": [
		{
			"id": "sec-outer-delve",
			"title": "Outer Delve",
			"level": "15-20",
			"steps": [
				{
					"id": "st-cavern-lore",
					"kind": "info",
					"title": "Water levels rise and fall with the surface bell",
					"notes": "Ringing the bronze bell opens the lower sluice gates."
				},
				{
					"id": "st-sluice-caches",
					"kind": "task",
					"title": "Clear the three Sluice Gallery caches",
					"place": "Sluice Gallery",
					"targets": [
						{ "kind": "marker", "marker": 2001, "label": "West Alcove Chest" },
						{ "kind": "marker", "marker": 2002, "label": "Sunken Grate Chest" },
						{ "kind": "marker", "marker": 2003, "label": "Pillar Ledge Chest", "optional": true }
					],
					"reward": "2x Sunstone Shard"
				},
				{
					"id": "st-sluice-lever",
					"kind": "task",
					"title": "Pull the counter-weight lever above the aqueduct",
					"samePlace": true,
					"consequence": "Drains the lower basin and seals the upper return tunnel."
				}
			]
		}
	],
	"created": 1760000100000,
	"updated": 1760000200000
}
```

### Example 3: Variants, Threads, Gate Notes & Snapshot Fallback (Level 4)

```json
{
	"v": 1,
	"id": "citadel-routes",
	"game": "sunlit-reach",
	"title": "Skyward Citadel & Side Threads",
	"variants": [
		{
			"id": "pact",
			"label": "Faction Pact",
			"options": [
				{ "id": "wardens", "label": "Order of Wardens" },
				{ "id": "scholars", "label": "Glass Scholars" }
			],
			"default": "wardens"
		}
	],
	"sections": [
		{
			"id": "sec-approach",
			"title": "Citadel Approach",
			"gate": "Requires the Skyhook grappling tool.",
			"steps": [
				{
					"id": "st-warden-envoy",
					"kind": "task",
					"title": "Meet Envoy Kael on the battlement",
					"targets": [
						{
							"kind": "marker",
							"marker": 3002,
							"snapshot": {
								"title": "Envoy Kael",
								"cat": "NPCs",
								"lat": 22.15,
								"lng": 14.75,
								"map": "citadel"
							}
						}
					],
					"missable": true,
					"thread": "Warden Covenant",
					"only": { "pact": ["wardens"] }
				}
			]
		}
	],
	"created": 1760000300000,
	"updated": 1760000400000
}
```

---

## Instructions for an Assistant Converting an Existing Guide

When asked to convert a text walkthrough or checklist into a Verticordia Atlas JSON guide, follow these rules strictly:

1. **Use only what the source states**: Do not add steps, rewards, consequences, or prerequisites that are not stated in the material you were given.
2. **Leave unknown fields out**: Every optional field (`description`, `notes`, `targets`, `place`, `reward`, `consequence`, `thread`, `only`, `links`, `zone`) should be omitted when the source does not provide it.
3. **Never invent marker IDs**: Only emit a `{ "kind": "marker", "marker": <id> }` target when you have an exact integer ID from the game's data or from a `#loc=<id>` / `locationIds=<id>` link. If a step mentions a location by name without an explicit verified ID, leave `targets` out and keep the location name in `title` or `place`.
4. **Put anything unclear in `notes`**: Conditional edge cases, multi-sentence explanations, or ambiguous directions belong in the step's Markdown `notes` (or `consequence` when warning about a lockout/point of no return).
5. **Respect ID and length constraints**:
    - Root `v` must be `1`.
    - `id` matches `/^[A-Za-z0-9_-]{4,24}$/`.
    - Section and step `id` values must be unique within the guide and match `/^[A-Za-z0-9_-]{1,40}$/`.
    - Keep `title` ≤ 120 characters; move longer explanations into `notes`.
6. **Output only valid JSON**: Return a single JSON object conforming to `docs/guide.schema.json`, with no surrounding commentary or Markdown code fences unless requested.