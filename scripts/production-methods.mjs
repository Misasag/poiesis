import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';
import ts from 'typescript';

// Run production browser methods without starting Theia's DOM-dependent services.
export function productionMethods(path, className, names, dependencies = {}) {
    const source = ts.createSourceFile(path, readFileSync(new URL(path, import.meta.url), 'utf8'),
        ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
    const declaration = source.statements.find(node => ts.isClassDeclaration(node) && node.name?.text === className);
    assert(declaration, className);
    const members = names.map(name => {
        const member = declaration.members.find(node => node.name?.getText(source) === name);
        assert(member, `${className}.${name}`);
        return member.getText(source);
    });
    const { outputText } = ts.transpileModule(`class Subject { ${members.join('\n')} }\nSubject;`, {
        compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.None }
    });
    return new (vm.runInNewContext(outputText, { console, ...dependencies }))();
}
