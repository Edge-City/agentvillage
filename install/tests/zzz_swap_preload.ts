/** Test-only hook: exchange the marker immediately after zzzShippedFile's first lstat. */
import { plugin } from "bun";
import { readFileSync } from "node:fs";

const IMPORT = "fstatSync, lstatSync, mkdirSync";
const HOOK = `
import { renameSync } from "node:fs";
let swapped = false;
const lstatSync = (path: string) => {
  const metadata = nativeLstatSync(path);
  if (!swapped && path === process.env.ZZZ_SWAP_TARGET && process.env.ZZZ_SWAP_REPLACEMENT) {
    swapped = true;
    renameSync(process.env.ZZZ_SWAP_REPLACEMENT, path);
  }
  return metadata;
};
`;

plugin({
  name: "zzz-marker-swap-test",
  setup(build) {
    build.onLoad({ filter: /[\\/]install[\\/]zzz_managed_job\.ts$/ }, args => {
      const source = readFileSync(args.path, "utf8");
      if (source.split(IMPORT).length !== 2) throw new Error("zzz_swap_preload: fs import changed");
      return { contents: source.replace(IMPORT, "fstatSync, lstatSync as nativeLstatSync, mkdirSync") + HOOK, loader: "ts" };
    });
  },
});
