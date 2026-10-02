import { formatReport } from './format.ts';
import { describe } from './stats.ts';

// TODO: validate arguments (non-numeric input should print a helpful error and exit 1)
const values = process.argv.slice(2).map(Number);
console.log(formatReport(describe(values)));
