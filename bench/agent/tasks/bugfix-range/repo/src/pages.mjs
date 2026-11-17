import { range } from "./range.mjs";

// Page numbers 1..count, for a pager.
export const pages = (count) => range(1, count + 1);
