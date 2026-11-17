// Dollars → integer cents; round, since amount * 100 can land just below the exact cents (0.29 * 100 is 28.999…).
export const toCents = (amount) => Math.round(amount * 100);
