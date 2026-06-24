#!/usr/bin/env tsx
/**
 * index.ts — deploy CLI 入口
 *
 * Usage: pnpm -F api deploy <command> [flags]
 *
 * Subcommands:
 *   push           Read secrets from Keychain + push to cloud function
 *                 Default: Merge (preserves other vars). Use --override for full replace.
 *   rotate-kek     Generate new KEK_SECRET_V1 + write Keychain + push
 *   clean          Reset cloud function to 7 vars clean template (secrets cleared)
 *   status         Show current cloud env vars + recent deploy audit history
 *   full           bundle + tcb fn deploy + push 三步一气呵成 (P7 follow-up of P6)
 *
 * Flags:
 *   --override              Use Override update instead of Merge (push only)
 *   --force                 Skip KEK_CURRENT_VERSION drift check + skip rotate-kek confirmation
 *   --skip-audit            Don't write audit_log entry
 *   --no-build              (full only) 跳过 build + tcb fn deploy, 只 push
 *   --skip-push             (full only) 跑 build + tcb fn deploy, 跳过 push
 *   -h, --help              Show this help
 */

import { parseArgs } from "node:util";
import { push } from "./commands/push.js";
import { rotateKek } from "./commands/rotate-kek.js";
import { clean } from "./commands/clean.js";
import { status } from "./commands/status.js";
import { deployFull } from "./commands/deploy-full.js";
import { logger } from "./lib/logger.js";

const HELP = `Usage: pnpm -F api deploy <command> [flags]

Commands:
  push           Read secrets from Keychain + push to cloud function
                 Default: Merge (preserves other vars). Use --override for full replace.
  rotate-kek     Generate new KEK_SECRET_V1 + write Keychain + push
  clean          Reset cloud function to 7 vars clean template (secrets cleared)
  status         Show current cloud env vars + recent deploy audit history
  full           bundle + tcb fn deploy + push 三步一气呵成

Flags:
  --override              Use Override update instead of Merge (push / full only)
  --force                 Skip KEK_CURRENT_VERSION drift check + skip rotate-kek confirmation
  --skip-audit            Don't write audit_log entry
  --no-build              (full only) 跳过 build + tcb fn deploy, 只 push
  --skip-push             (full only) 跑 build + tcb fn deploy, 跳过 push
  -h, --help              Show this help
`;

const { values, positionals } = parseArgs({
  options: {
    override: { type: "boolean", default: false },
    force: { type: "boolean", default: false },
    "skip-audit": { type: "boolean", default: false },
    "no-build": { type: "boolean", default: false },
    "skip-push": { type: "boolean", default: false },
    help: { type: "boolean", short: "h", default: false },
  },
  allowPositionals: true,
});

const [cmd] = positionals;

if (values.help || !cmd) {
  console.log(HELP);
  process.exit(0);
}

try {
  switch (cmd) {
    case "push":
      await push(values);
      break;
    case "rotate-kek":
      await rotateKek(values);
      break;
    case "clean":
      await clean(values);
      break;
    case "status":
      await status(values);
      break;
    case "full":
      await deployFull({
        noBuild: values["no-build"],
        skipPush: values["skip-push"],
        override: values.override,
        force: values.force,
        skipAudit: values["skip-audit"],
      });
      break;
    default:
      console.error(`Unknown command: ${cmd}\n\n${HELP}`);
      process.exit(1);
  }
} catch (err) {
  logger.fatal(err);
}