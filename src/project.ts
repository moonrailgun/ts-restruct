import {
  FunctionDeclarationStructure,
  Project,
  ProjectOptions,
  Node,
  SyntaxKind,
  MethodDeclarationStructure,
  ImportDeclarationStructure,
  OptionalKind,
} from 'ts-morph';
import fg, { Options as GlobOptions } from 'fast-glob';
import fs from 'fs-extra';
import path from 'path';
import chalk from 'chalk';

interface RestructionProjectOptions {
  dry?: boolean;
  cwd?: string;
  project: ProjectOptions;
}

interface MoveOptions {
  autoResolveConflict?: boolean;
  /**
   * Whether use simple fs.move, default use ts.move
   */
  useSimpleMove?: boolean;
}

export class RestructionProject {
  project: Project;

  constructor(public options: RestructionProjectOptions) {
    this.project = new Project({
      ...options.project,
    });
  }

  get cwd() {
    return this.options.cwd ?? process.cwd();
  }

  get dry() {
    return this.options.dry ?? false;
  }

  async refresh() {
    await Promise.all(
      this.project
        .getSourceFiles()
        .map((source) => source.refreshFromFileSystem())
    );
  }

  async rm(glob: string, options?: GlobOptions) {
    const files = await fg(glob, {
      ...options,
      cwd: this.cwd,
    });

    files.forEach((file) => console.log(`${chalk.red('[DELETE]')} ${file}`));
    if (!this.dry) {
      await Promise.all(files.map((file) => fs.remove(file)));
    }
  }

  /**
   * Create file
   */
  async create(filepath: string, content = '') {
    const file = this.project.createSourceFile(filepath, content);

    await file.save();
  }

  async writeAppend(filepath: string, content: string) {
    console.log(
      `${chalk.blue('[ADD]')} write content(size: ${
        content.length
      }) into ${filepath}`
    );

    const source = this.project.getSourceFile(filepath);

    if (source) {
      source.insertText(Math.max(0, source.getEnd() - 1), content);
      await source.save();
    } else {
      await fs.appendFile(filepath, content, { encoding: 'utf8' });
    }
  }

  async addImportDeclaration(
    structure: OptionalKind<ImportDeclarationStructure>,
    filepath: string
  ) {
    console.log(
      `${chalk.blue('[ADD]')} add import declaration into ${filepath}`
    );
    const source = this.project.getSourceFileOrThrow(filepath);
    source.addImportDeclaration(structure);

    await source.save();
  }

  /**
   * Move file in ts project, will auto refactor path
   */
  async move(from: string, pattern: string, to: string, options?: MoveOptions) {
    const { autoResolveConflict = false, useSimpleMove = false } =
      options ?? {};
    const fromFiles = await fg(pattern, {
      cwd: path.resolve(this.cwd, from),
    });
    const absFrom = path.resolve(this.cwd, from);
    const absTo = path.resolve(this.cwd, to);

    let ops = false; // has modify with ts
    await Promise.all(
      fromFiles.map(async (file) => {
        console.log(
          `${chalk.blue('[MOVE]')} ${path.join(from, file)} ${chalk.blueBright(
            '=>'
          )} ${path.relative(this.cwd, path.resolve(absTo, file))}`
        );

        if (this.dry) {
          return;
        }

        const p = path.join(from, file);

        if (
          autoResolveConflict &&
          (await fs.exists(path.resolve(absTo, file)))
        ) {
          // file have conflict
          const relativeFrom = path.relative(
            this.cwd,
            path.resolve(absFrom, file)
          );
          const relativeTo = path.relative(this.cwd, path.resolve(absTo, file));
          console.log(
            `${chalk.bgYellow(
              'Warning!'
            )} File path conflict: ${relativeFrom} ${chalk.blueBright(
              '=>'
            )} ${relativeTo}`
          );

          await this.simpleMergeConflictFile(relativeFrom, relativeTo);
          await fs.rm(path.resolve(absFrom, file));

          return;
        }

        if (useSimpleMove) {
          const targetPath = path.resolve(to, file);
          await fs.move(p, targetPath);
        } else {
          const source = this.project.getSourceFile(p);
          if (source) {
            source.move(path.resolve(absTo, file));
            ops = true;
          } else {
            console.log(
              `${chalk.bgYellow(
                'Warning!'
              )} Not found file [${p}] in ts project, fallback to simple fs operation`
            );
            const targetPath = path.resolve(to, file);
            await fs.move(p, targetPath);
          }
        }
      })
    );

    if (ops) {
      await this.project.save();
    }
  }

  /**
   * Move files and auto merge conflict files
   */
  async moveAndMerge(from: string, pattern: string, to: string) {
    await this.move(from, pattern, to, {
      autoResolveConflict: true,
      useSimpleMove: true,
    });
  }

  /**
   * Edit file with function
   * @param path file path
   * @param fn text edit function
   */
  async edit(path: string, fn: (text: string) => Promise<string> | string) {
    console.log(`${chalk.blue('[EDIT]')} ${path}`);

    const text = await fs.readFile(path, { encoding: 'utf8' });

    const newText = await fn(text);

    await fs.writeFile(path, newText, { encoding: 'utf8' });

    const source = this.project.getSourceFile(path);
    if (source) {
      await source.refreshFromFileSystem();
    }
  }

  /**
   * shortcuts with edit
   */
  async editReplace(
    path: string,
    searchValue: string | RegExp,
    replaceValue: string,
    replaceAll = false
  ) {
    await this.edit(path, (text) =>
      replaceAll
        ? text.replaceAll(searchValue, replaceValue)
        : text.replace(searchValue, replaceValue)
    );
    console.log(
      `└ ${replaceAll ? 'replace all' : 'replace'}: ${String(
        searchValue
      )} ${chalk.blueBright('=>')} ${replaceValue}`
    );
  }

  async editReplaceAllBatch(
    pattern: string,
    searchValue: string,
    replaceValue: string
  ) {
    const files = await fg(pattern, {
      cwd: this.cwd,
    });
    for (const file of files) {
      if (
        (await fs.readFile(path.resolve(this.cwd, file))).includes(searchValue)
      ) {
        await this.editReplace(file, searchValue, replaceValue, true);
      }
    }
  }

  /**
   * Move your ts function append into another file path
   * @param fnName
   * @param from path
   * @param to path
   */
  async moveFn(fnName: string, from: string, to: string) {
    console.log(
      `${chalk.blue('[MOVE]')} function [${fnName}]: ${from} ${chalk.blueBright(
        '=>'
      )} ${to}`
    );
    const source = this.project.getSourceFileOrThrow(from);
    const target = this.project.getSourceFileOrThrow(to);

    const declaration = source.getFunctionOrThrow(fnName);

    target.addFunction(
      declaration.getStructure() as FunctionDeclarationStructure
    );

    await target.save();
  }

  /**
   * Move your var statement append into another file path
   * @param varName
   * @param from path
   * @param to path
   */
  async moveVar(varName: string, from: string, to: string) {
    console.log(
      `${chalk.blue('[MOVE]')} var [${varName}]: ${from} ${chalk.blueBright(
        '=>'
      )} ${to}`
    );
    const source = this.project.getSourceFileOrThrow(from);
    const target = this.project.getSourceFileOrThrow(to);

    const statement = source.getVariableStatementOrThrow(varName);

    const structure = statement.getStructure();
    structure.trailingTrivia = this.getNodeTrailingCommentArr(statement);
    target.addVariableStatement(structure);

    await target.save();
  }

  /**
   * Move your type append into another file path
   * @param typeName
   * @param from path
   * @param to path
   */
  async moveTypeAlias(typeName: string, from: string, to: string) {
    console.log(
      `${chalk.blue('[MOVE]')} type [${typeName}]: ${from} ${chalk.blueBright(
        '=>'
      )} ${to}`
    );
    const source = this.project.getSourceFileOrThrow(from);
    const target = this.project.getSourceFileOrThrow(to);

    const declaration = source.getTypeAliasOrThrow(typeName);

    const structure = declaration.getStructure();
    structure.trailingTrivia = this.getNodeTrailingCommentArr(declaration);
    target.addTypeAlias(structure);

    await target.save();
  }

  /**
   * Move your enum declaration append into another file path
   * @param enumName
   * @param from path
   * @param to path
   */
  async moveEnum(enumName: string, from: string, to: string) {
    console.log(
      `${chalk.blue('[MOVE]')} enum [${enumName}]: ${from} ${chalk.blueBright(
        '=>'
      )} ${to}`
    );
    const source = this.project.getSourceFileOrThrow(from);
    const target = this.project.getSourceFileOrThrow(to);

    const declaration = source.getEnumOrThrow(enumName);

    target.insertText(target.getEnd() - 1, declaration.getFullText()); // Order to keep comments between members

    await target.save();
  }

  /**
   * Move your interface declaration append into another file path
   * @param interfaceName
   * @param from path
   * @param to path
   */
  async moveInterface(interfaceName: string, from: string, to: string) {
    console.log(
      `${chalk.blue(
        '[MOVE]'
      )} interface [${interfaceName}]: ${from} ${chalk.blueBright('=>')} ${to}`
    );
    const source = this.project.getSourceFileOrThrow(from);
    const target = this.project.getSourceFileOrThrow(to);

    const declaration = source.getInterfaceOrThrow(interfaceName);

    target.insertText(target.getEnd() - 1, declaration.getFullText()); // Order to keep comments between members

    await target.save();
  }

  /**
   * delete var statement
   */
  async deleteVar(varName: string, path: string) {
    console.log(`${chalk.red('[DELETE]')} var [${varName}] in ${path}`);
    const source = this.project.getSourceFileOrThrow(path);
    const statement = source.getVariableStatementOrThrow(varName);

    statement.remove();

    await source.save();
  }

  async deleteInterface(name: string, path: string) {
    console.log(`${chalk.red('[DELETE]')} interface [${name}] in ${path}`);
    const source = this.project.getSourceFileOrThrow(path);
    const declaration = source.getInterfaceOrThrow(name);

    declaration.remove();

    await source.save();
  }

  /**
   * delete import declaration
   * @param moduleName path
   * @param path
   */
  async deleteImport(moduleName: string, path: string) {
    console.log(`${chalk.red('[DELETE]')} import [${moduleName}] in ${path}`);
    const source = this.project.getSourceFileOrThrow(path);
    const declaration = source.getImportDeclarationOrThrow(moduleName);

    declaration.remove();

    await source.save();
  }

  /**
   * Delete named import
   */
  async deleteNamedImport(
    namedImport: string,
    moduleName: string,
    path: string,
    deleteIfEmpty = true
  ) {
    console.log(
      `${chalk.red(
        '[DELETE]'
      )} named import { ${namedImport} } from '${moduleName}' in ${path}`
    );
    const source = this.project.getSourceFileOrThrow(path);

    const declaration = source.getImportDeclarationOrThrow(moduleName);
    if (declaration) {
      const namedImports = declaration.getNamedImports();
      const importSpecifier = namedImports.find(
        (n) => n.getName() === namedImport
      );

      if (namedImports) {
        if (deleteIfEmpty && namedImports.length === 1) {
          // delete if found named import and only has this import
          declaration.remove();
        } else {
          importSpecifier.remove();
        }
      }
    }

    await source.save();
  }

  /**
   * delete function declaration
   * @param moduleName path
   * @param path
   */
  async deleteFunction(functionName: string, path: string) {
    console.log(
      `${chalk.red('[DELETE]')} function [${functionName}] in ${path}`
    );
    const source = this.project.getSourceFileOrThrow(path);
    const declaration = source.getFunctionOrThrow(functionName);

    declaration.remove();

    await source.save();
  }

  /**
   * merge parent class into current class
   *
   * NOTICE: only support one level
   */
  async unextendsClass(className: string, filepath: string) {
    console.log(
      `${chalk.green('[MERGE]')} unextendsClass [${className}] in ${filepath}`
    );

    const source = this.project.getSourceFileOrThrow(filepath);
    const classDeclaration = source.getClassOrThrow(className);

    const parentIdentifier = classDeclaration
      .getHeritageClauseByKindOrThrow(SyntaxKind.ExtendsKeyword)
      .getTypeNodes()[0] // only get first
      .getExpressionIfKind(SyntaxKind.Identifier);
    const parentSource = parentIdentifier
      .findReferences()
      .map((ref) => ref.getDefinition().getSourceFile())
      .find((file) => file.getFilePath() !== source.getFilePath());

    if (!parentSource) {
      throw new Error('not found parent');
    }

    const parentClassName = parentIdentifier.getText();
    const parentClass = parentSource.getClassOrThrow(parentClassName);
    console.log(
      `└ found parent class [${parentClassName}] in: ${path.relative(
        this.cwd,
        parentSource.getFilePath()
      )}`
    );

    // merge
    console.log(`  - start merge`);
    const classPropertyNames = classDeclaration
      .getProperties()
      .map((p) => p.getName());

    parentClass.getProperties().forEach((p) => {
      const name = p.getName();
      if (classPropertyNames.includes(name)) {
        console.log(`  - skip property: [${name}]`);
      } else {
        console.log(`  - append property: [${name}]`);
        const structure = p.getStructure();
        structure.leadingTrivia = this.getNodeLeadingCommentArr(p);
        classDeclaration.addProperty(structure);
      }
    });

    parentClass.getGetAccessors().forEach((p) => {
      const name = p.getName();
      if (classPropertyNames.includes(name)) {
        console.log(`  - skip getter: [${name}]`);
      } else {
        console.log(`  - append getter: [${name}]`);
        const structure = p.getStructure();
        structure.leadingTrivia = this.getNodeLeadingCommentArr(p);
        classDeclaration.addGetAccessor(structure);
      }
    });

    parentClass.getSetAccessors().forEach((p) => {
      const name = p.getName();
      if (classPropertyNames.includes(name)) {
        console.log(`  - skip setter: [${name}]`);
      } else {
        console.log(`  - append setter: [${name}]`);
        const structure = p.getStructure();
        structure.leadingTrivia = this.getNodeLeadingCommentArr(p);
        classDeclaration.addSetAccessor(structure);
      }
    });

    parentClass.getMethods().forEach((p) => {
      const name = p.getName();
      if (classPropertyNames.includes(name)) {
        console.log(`  - skip method: [${name}]`);
      } else {
        console.log(`  - append method: [${name}]`);
        if (p.isOverload) {
          console.log(
            `    ${chalk.bgYellow(
              'Warning!'
            )} Not support overload class method: ${name}`
          );
          return;
        }

        const structure = p.getStructure() as MethodDeclarationStructure;
        structure.leadingTrivia = this.getNodeLeadingCommentArr(p);
        classDeclaration.addMethod(structure);
      }
    });

    // remove parent
    classDeclaration.removeExtends();

    await source.save();
  }

  /**
   * list same files before move
   */
  async checkConflictFilesBeforeMove(
    from: string,
    pattern: string,
    to: string
  ) {
    const absFrom = path.resolve(this.cwd, from);
    const fromFiles = await fg(pattern, {
      cwd: path.resolve(this.cwd, from),
    });
    const absTo = path.resolve(this.cwd, to);

    for (const file of fromFiles) {
      if (await fs.exists(path.resolve(absTo, file))) {
        console.log(
          `${chalk.bgYellow('Warning!')} File path conflict: ${path.relative(
            this.cwd,
            path.resolve(absFrom, file)
          )} ${chalk.blueBright('=>')} ${path.relative(
            this.cwd,
            path.resolve(absTo, file)
          )}`
        );
      }
    }
  }

  /**
   * Simple Merge:
   * - merge imports
   * - merge others
   */
  async simpleMergeConflictFile(fromPath: string, toPath: string) {
    console.log(
      `${chalk.green('[MERGE]')} simple merge [${fromPath}] into ${toPath}`
    );
    const from = this.project.getSourceFileOrThrow(fromPath);
    const to = this.project.getSourceFileOrThrow(toPath);

    const imports = from.getImportDeclarations();
    to.addImportDeclarations(
      imports
        .filter((i) => i.getModuleSpecifierSourceFile() !== to)
        .map((i) => i.getStructure())
    );
    await to.save();

    const allNodes = from
      .getStatements()
      .filter((node) => !node.isKind(SyntaxKind.ImportDeclaration));

    await this.writeAppend(
      toPath,
      '\n\n' + allNodes.map((node) => node.getFullText()).join('')
    );
  }

  private getNodeLeadingCommentArr(node: Node): string[] {
    return [...node.getLeadingCommentRanges().map((r) => r.getText())];
  }

  private getNodeTrailingCommentArr(node: Node): string[] {
    return [' ', ...node.getTrailingCommentRanges().map((r) => r.getText())];
  }
}
