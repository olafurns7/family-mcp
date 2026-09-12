import { defineRule } from "@oxlint/plugins";
import type { ESTree } from "@oxlint/plugins";

const safeErrorMessageIndex = new Map([
	["SafeError", 0],
	["InfoMentorError", 1],
]);

function isLiteralMessage(node: ESTree.Node | undefined): boolean {
	return (
		(node?.type === "Literal" && typeof node.value === "string") ||
		(node?.type === "TemplateLiteral" && node.expressions.length === 0)
	);
}

/** Keep SafeError messages fixed so MCP errors cannot expose upstream data. */
export const safeErrorLiteralMessageRule = defineRule({
	meta: {
		type: "problem",
		docs: {
			description:
				"Require SafeError and InfoMentorError messages to be fixed literals so untrusted data cannot reach MCP callers.",
		},
		messages: {
			safeErrorLiteralMessage:
				"SafeError messages must be a string literal or a template literal without expressions.",
		},
	},
	createOnce(context) {
		return {
			NewExpression(node) {
				if (node.callee.type !== "Identifier") return;
				const index = safeErrorMessageIndex.get(node.callee.name);
				if (index === undefined || isLiteralMessage(node.arguments[index])) return;
				context.report({ node, messageId: "safeErrorLiteralMessage" });
			},
		};
	},
});
