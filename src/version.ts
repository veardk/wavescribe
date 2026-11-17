import fs from "node:fs";

/** Package version, read from package.json (one directory above both src/ and dist/). */
export const VERSION: string = JSON.parse(fs.readFileSync(new URL("../package.json", import.meta.url), "utf8")).version;
