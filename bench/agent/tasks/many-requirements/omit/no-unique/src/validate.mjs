const KNOWN = ["name", "email", "age", "tags"];
const EMAIL = /^[^\s@]+@[^\s@.]+(\.[^\s@.]+)+$/;

// The problems with a user record, in rule order; [] when it is valid.
export function validateUser(user) {
	if (typeof user !== "object" || user === null || Array.isArray(user)) return ["user must be an object"];
	const errors = [];
	const { name, email, age, tags } = user;
	if (typeof name !== "string" || !name.trim()) errors.push("name is required");
	if (typeof email !== "string" || !EMAIL.test(email)) errors.push("email is invalid");
	if (!Number.isInteger(age)) errors.push("age must be an integer");
	else if (age < 13 || age > 120) errors.push("age must be between 13 and 120");
	if (tags !== undefined) {
		if (!Array.isArray(tags) || !tags.every((t) => typeof t === "string")) errors.push("tags must be an array of strings");
		else {
			if (tags.some((t) => t !== t.toLowerCase())) errors.push("tags must be lowercase");
		}
	}
	for (const key of Object.keys(user)) if (!KNOWN.includes(key)) errors.push(`unknown field: ${key}`);
	return errors;
}
