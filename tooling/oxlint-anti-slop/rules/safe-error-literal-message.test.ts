import { RuleTester } from "oxlint/plugins-dev";

import { safeErrorLiteralMessageRule } from "./safe-error-literal-message.ts";

const tester = new RuleTester({ languageOptions: { parserOptions: { lang: "ts" } } });
const error = { messageId: "safeErrorLiteralMessage" };

tester.run("anti-slop/safe-error-literal-message", safeErrorLiteralMessageRule, {
	valid: [
		'new SafeError("A fixed message.");',
		"new SafeError(`A fixed message.`);",
		'new InfoMentorError("LOGIN_REQUIRED", "A fixed message.");',
		"new InfoMentorError('LOGIN_REQUIRED', `A fixed message.`, 1000);",
		"new Error(message);",
	],
	invalid: [
		{ code: "new SafeError(message);", errors: [error] },
		{ code: "new SafeError(`A ${message} message.`);", errors: [error] },
		{ code: "new InfoMentorError('LOGIN_REQUIRED', message);", errors: [error] },
		{
			code: "new InfoMentorError('LOGIN_REQUIRED', `A ${message} message.`);",
			errors: [error],
		},
		{ code: "new InfoMentorError('LOGIN_REQUIRED');", errors: [error] },
	],
});
