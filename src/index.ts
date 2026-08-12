import { createRootCommand } from "./cli/root.js";

const program = createRootCommand();
program.parse();
