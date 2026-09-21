// Copyright 2026, Command Line Inc.
// SPDX-License-Identifier: Apache-2.0

import { readFileSync } from "node:fs";
import ts from "typescript";
import { describe, expect, it } from "vitest";

// Narrow source-contract tests: the model imports RPC/React/Monaco surfaces.
// These inspect only this model, not GUI rendering, config refresh or runtime activation.
const source = ts.createSourceFile(
    "waveconfig-model.ts",
    readFileSync(new URL("./waveconfig-model.ts", import.meta.url), "utf8"),
    ts.ScriptTarget.Latest,
    true
);
const model = source.statements.find(
    (node): node is ts.ClassDeclaration => ts.isClassDeclaration(node) && node.name?.text === "WaveConfigViewModel"
)!;
const makeFiles = source.statements.find(
    (node): node is ts.FunctionDeclaration => ts.isFunctionDeclaration(node) && node.name?.text === "makeConfigFiles"
)!;

function method(name: string): ts.MethodDeclaration {
    const found = model.members.find(
        (node): node is ts.MethodDeclaration => ts.isMethodDeclaration(node) && node.name.getText(source) === name
    );
    expect(found, `public model method ${name} must survive`).toBeDefined();
    return found!;
}

function property(object: ts.ObjectLiteralExpression, name: string): ts.Expression | undefined {
    const found = object.properties.find(
        (node): node is ts.PropertyAssignment => ts.isPropertyAssignment(node) && node.name.getText(source) === name
    );
    return found?.initializer;
}

function descriptors(): ts.ObjectLiteralExpression[] {
    const result = makeFiles.body!.statements.find(ts.isReturnStatement)?.expression;
    expect(result && ts.isArrayLiteralExpression(result)).toBe(true);
    const elements = (result as ts.ArrayLiteralExpression).elements;
    expect(elements.every(ts.isObjectLiteralExpression)).toBe(true);
    return Array.from(elements) as ts.ObjectLiteralExpression[];
}

describe("retained Settings descriptor contract (source-level)", () => {
    it("offers only the five retained configuration paths in sidebar order", () => {
        const paths = descriptors().map((file) => {
            const value = property(file, "path")!;
            expect(ts.isStringLiteral(value)).toBe(true);
            return (value as ts.StringLiteral).text;
        });
        expect(paths).toEqual(["settings.json", "connections.json", "widgets.json", "backgrounds.json", "secrets"]);
    });

    it("keeps both public ConfigFile[] methods required by the unchanged sidebar", () => {
        for (const name of ["getConfigFiles", "getDeprecatedConfigFiles"]) {
            const member = method(name);
            expect(member.parameters).toHaveLength(0);
            expect(member.type?.getText(source)).toBe("ConfigFile[]");
            const nonPublic = member.modifiers?.some(
                (m) => m.kind === ts.SyntaxKind.PrivateKeyword || m.kind === ts.SyntaxKind.ProtectedKeyword
            );
            expect(nonPublic ?? false).toBe(false);
        }
        expect(method("getConfigFiles").body?.getText(source)).toContain("makeConfigFiles(this.env.isWindows())");
    });

    it("returns no deprecated entries regardless of whether old preset files exist", () => {
        const body = method("getDeprecatedConfigFiles").body!;
        expect(body.statements).toHaveLength(1);
        const statement = body.statements[0];
        expect(ts.isReturnStatement(statement)).toBe(true);
        const result = (statement as ts.ReturnStatement).expression!;
        expect(ts.isArrayLiteralExpression(result)).toBe(true);
        expect((result as ts.ArrayLiteralExpression).elements).toHaveLength(0);
    });

    it("has no legacy descriptor validators or file-existence visibility probe", () => {
        const topNames = source.statements.flatMap((node) => {
            if (ts.isFunctionDeclaration(node)) return node.name ? [node.name.text] : [];
            if (ts.isVariableStatement(node)) return node.declarationList.declarations.map((d) => d.name.getText(source));
            return [];
        });
        expect(topNames).not.toContain("deprecatedConfigFiles");
        expect(topNames).not.toContain("validateAiJson");
        expect(topNames).not.toContain("validateWaveAiJson");
        const memberNames = model.members.map((m) => m.name?.getText(source));
        expect(memberNames).not.toContain("presetsJsonExistsAtom");
        expect(memberNames).not.toContain("checkPresetsJsonExists");
    });

    it("preserves the first-retained-file fallback and load route for stale file metadata", () => {
        const body = method("initialize").body!.getText(source);
        expect(body).toContain('getBlockMetaKeyAtom(this.blockId, "file")');
        expect(body).toContain("configFiles.find((f) => f.path === savedFilePath)");
        expect(body).toMatch(/if\s*\(!fileToLoad\)\s*\{\s*fileToLoad = configFiles\[0\];\s*\}/);
        expect(body).toContain("this.loadFile(fileToLoad)");
    });

    it("preserves both raw-file save RPC branches without claiming runtime config refresh", () => {
        const body = method("saveFile").body!.getText(source);
        expect(body.match(/await this\.env\.rpc\.FileWriteCommand\(TabRpcClient,/g)).toHaveLength(2);
        expect(body).toContain('data64: stringToBase64("")');
        expect(body).toContain("data64: stringToBase64(formatted)");
    });

    it("preserves localized Connections descriptions and the existing Secrets component sink", () => {
        const files = descriptors();
        const connection = files.find((f) => property(f, "path")?.getText(source) === '"connections.json"')!;
        expect(property(connection, "description")?.getText(source)).toMatch(
            /isWindows\s*\? uiText\("config.connectionsWindowsDescription"\)\s*: uiText\("config.connectionsDescription"\)/
        );
        const secrets = files.find((f) => property(f, "path")?.getText(source) === '"secrets"')!;
        expect(property(secrets, "name")?.getText(source)).toBe('uiText("config.secrets")');
        expect(property(secrets, "isSecrets")?.kind).toBe(ts.SyntaxKind.TrueKeyword);
        expect(property(secrets, "hasJsonView")?.kind).toBe(ts.SyntaxKind.FalseKeyword);
        expect(property(secrets, "visualComponent")?.getText(source)).toBe("SecretsContent");
    });
});
