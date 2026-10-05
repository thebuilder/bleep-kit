import fs from "node:fs";
import path from "node:path";
import { deriveSeed, normalizeSfx, type Sfx } from "@bleepkit/core";
import { describeSfx, mutateMany } from "@bleepkit/sfx";
import { CliError } from "../output.ts";
import {
  checkId,
  docRel,
  loadDoc,
  openProject,
  type ProjectCtx,
  requireOk,
  resolveRef,
  writeDoc,
} from "../project.ts";
import type { CommandSpec } from "./types.ts";

function freeIds(pc: ProjectCtx, base: string, count: number): string[] {
  const out: string[] = [];
  let n = 1;
  while (out.length < count) {
    const id = `${base}${n}`;
    if (!fs.existsSync(path.join(pc.root, docRel("sfx", id)))) {
      out.push(id);
    }
    n += 1;
  }
  return out;
}

export const mutateCommand: CommandSpec = {
  description:
    "Writes nudged variations of an sfx (sfx only today). Without --out the copies are named <id>-m1, <id>-m2, ... " +
    "taking the first free numbers, so repeated runs never overwrite. With --out <id> a single copy is written as " +
    "<id> (several copies as <id>-1, <id>-2, ...). --amount 0 reproduces the original; larger amounts change more " +
    "fields. Descriptions are printed so you can pick without listening.",
  examples: [
    "bleepkit mutate sfx/coin --count 4",
    "bleepkit mutate sfx/laser --amount 0.4 --out laser-wild",
  ],
  flags: [
    {
      default: "0.15",
      description: "how much to change, 0 to 1",
      name: "amount",
      type: "number",
      valueName: "<0..1>",
    },
    {
      default: "1",
      description: "how many variations to write",
      name: "count",
      type: "number",
      valueName: "<n>",
    },
    {
      description: "id (base id when --count > 1) of the written document(s)",
      name: "out",
      type: "string",
      valueName: "<id>",
    },
    {
      description: "overwrite existing documents when --out is given",
      name: "force",
      type: "boolean",
    },
  ],
  name: "mutate",
  run: (ctx, args) => {
    const [refArg] = args.positionals;
    if (!refArg) {
      throw new CliError("usage", "mutate needs an sfx reference", {
        hint: "Example: bleepkit mutate sfx/coin --count 4",
      });
    }
    const pc = openProject(ctx);
    if (refArg.startsWith("song") || refArg.startsWith("instrument")) {
      throw new CliError("usage", "mutate only works on sfx today", {
        hint: "Use an sfx reference such as sfx/coin.",
      });
    }
    const r = resolveRef(pc, refArg, ["sfx"]);
    const doc = loadDoc(pc, "sfx", r.id);
    requireOk(doc);
    const amount = args.num("amount") ?? 0.15;
    const count = args.num("count") ?? 1;
    if (!(amount >= 0 && amount <= 1)) {
      throw new CliError("usage", `--amount must be 0 to 1 (got ${amount})`);
    }
    if (!(Number.isInteger(count) && count >= 1 && count <= 64)) {
      throw new CliError(
        "usage",
        `--count must be a whole number from 1 to 64 (got ${count})`
      );
    }
    const out = args.str("out");
    if (out) {
      checkId(out, "--out id");
    }
    let ids: string[];
    if (out) {
      ids =
        count === 1
          ? [out]
          : Array.from({ length: count }, (_, i) => `${out}-${i + 1}`);
      const clash = ids.find((id) =>
        fs.existsSync(path.join(pc.root, docRel("sfx", id)))
      );
      if (clash && !args.bool("force")) {
        throw new CliError("invalid", `sfx/${clash} already exists`, {
          hint: "Pick another --out id or pass --force to overwrite.",
        });
      }
    } else {
      ids = freeIds(pc, `${r.id}-m`, count);
    }
    const seed =
      args.num("seed") ?? ctx.seed ?? deriveSeed(pc.seed, `mutate:${r.id}`);
    const family = mutateMany(doc.value as Sfx, { amount, count, seed });
    const results = family.map((variant, i) => {
      const id = ids[i] as string;
      const n = normalizeSfx({ ...variant, name: `${doc.value.name} ${id}` });
      const rel = writeDoc(pc, "sfx", id, n.value);
      return { description: describeSfx(n.value), id, path: rel };
    });
    return {
      human: [
        `Wrote ${results.length} variation${results.length === 1 ? "" : "s"} of ${r.ref} (amount ${amount}, seed ${seed}):`,
        ...results.map((x) => `  sfx/${x.id}  ${x.description}`),
        `Next: bleepkit render ${results.map((x) => `sfx/${x.id}`).join(" ")} --analyze`,
      ].join("\n"),
      json: { ok: true, results, root: pc.root },
    };
  },
  summary: "write variations of an sfx",
  usage: "mutate <ref> [--amount 0.15] [--count 1] [--out <id>]",
};
