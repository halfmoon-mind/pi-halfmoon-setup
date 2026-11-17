// The problems with a user record, [] when it is valid.
export function validateUser(user) {
	const errors = [];
	if (!user.name?.trim()) errors.push("name is required");
	if (!user.email?.includes("@")) errors.push("email is invalid");
	return errors;
}
