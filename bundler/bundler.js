/************************************************************************
 * This file is part of EspoCRM.
 *
 * EspoCRM - Open Source CRM application.
 * Copyright (C) 2014-2023 Yurii Kuznietsov, Taras Machyshyn, Oleksii Avramenko
 * Website: https://www.espocrm.com
 *
 * EspoCRM is free software: you can redistribute it and/or modify
 * it under the terms of the GNU General Public License as published by
 * the Free Software Foundation, either version 3 of the License, or
 * (at your option) any later version.
 *
 * EspoCRM is distributed in the hope that it will be useful,
 * but WITHOUT ANY WARRANTY; without even the implied warranty of
 * MERCHANTABILITY or FITNESS FOR A PARTICULAR PURPOSE.  See the
 * GNU General Public License for more details.
 *
 * You should have received a copy of the GNU General Public License
 * along with EspoCRM. If not, see http://www.gnu.org/licenses/.
 *
 * The interactive user interfaces in modified source and object code versions
 * of this program must display Appropriate Legal Notices, as required under
 * Section 5 of the GNU General Public License version 3.
 *
 * In accordance with Section 7(b) of the GNU General Public License version 3,
 * these Appropriate Legal Notices must retain the display of the "EspoCRM" word.
 ************************************************************************/

const typescript = require('typescript');
const fs = require('fs');
const {globSync} = require('glob');

/**
 * Normalizes and concatenates Espo modules.
 *
 * Modules dependent on not bundled libs are ignored. Modules dependent on such modules
 * are ignored as well and so on.
 */
class Bundler {

    /**
     * @param {Object.<string, string>} modPaths
     * @param {string} [basePath]
     * @param {string} [transpiledPath]
     */
    constructor(modPaths, basePath, transpiledPath) {
        this.modPaths = modPaths;
        this.basePath = basePath ?? 'client';
        this.transpiledPath = transpiledPath ?? 'client/lib/transpiled';

        this.srcPath = this.basePath + '/src';
    }

    /**
     * Bundles Espo js files into chunks.
     *
     * @param {{
     *     name: string,
     *     files?: string[],
     *     patterns: string[],
     *     ignorePatterns: ?string[],
     *     ignoreFiles?: string[],
     *     lookupPatterns?: string[],
     *     ignoreFullPathFiles?: string[],
     *     dependentOn?: string[],
     *     mapDependencies?: boolean,
     *     libs: {
     *         src?: string,
     *         bundle?: boolean,
     *         amdId?: string,
     *     }[],
     * }} params
     * @return {{
     *     contents: string,
     *     files: string[],
     *     modules: string[],
     *     notBundledModules: string[],
     *     dependencyModules: string[],
     *     directDependencyModules: string[],
     * }}
     */
    bundle(params) {
        const ignoreFullPathFiles = params.ignoreFullPathFiles ?? [];
        const files = params.files ?? [];
        const ignoreFiles = params.ignoreFiles ?? [];

        const fullPathFiles = []
            .concat(this.#normalizePaths(params.files || []))
            .concat(this.#obtainFiles(params.patterns, [...files, ...ignoreFiles], params.ignorePatterns))
            // @todo Check if working.
            .filter(file => !ignoreFullPathFiles.includes(file));

        const allFiles = this.#obtainFiles(params.lookupPatterns || params.patterns);

        const ignoreLibs = params.libs
            .filter(item => item.amdId && !item.bundle)
            .map(item => item.amdId)
            .filter(item => !(params.dependentOn || []).includes(item));

        const notBundledModules = [];

        const {files: sortedFiles, depModules, directDepModules} = this.#sortFiles(
            params.name,
            fullPathFiles,
            allFiles,
            ignoreLibs,
            ignoreFullPathFiles,
            notBundledModules,
            params.dependentOn || null,
            params.mapDependencies,
            params.libs ?? []
        );

        let contents = '';

        this.#mapToTraspiledFiles(sortedFiles)
            .forEach(file => contents += this.#normalizeSourceFile(file) + '\n');

        const modules = sortedFiles.map(file => this.#obtainModuleName(file));

        const filteredDirectDepModules = directDepModules.filter(m => !modules.includes(m));

        return {
            contents: contents,
            files: sortedFiles,
            modules: modules,
            notBundledModules: notBundledModules,
            dependencyModules: depModules,
            directDependencyModules: filteredDirectDepModules,
        };
    }

    /**
     * @param {string[]} files
     * @return {string[]}
     */
    #mapToTraspiledFiles(files) {
        return files.map(file => {
            return this.transpiledPath + '/' + file.slice(this.basePath.length + 1);
        });
    }

    /**
     * @param {string[]} patterns
     * @param {string[]} [ignoreFiles]
     * @param {string[]} [ignorePatterns]
     * @return {string[]}
     */
    #obtainFiles(patterns, ignoreFiles, ignorePatterns) {
        let files = [];
        ignoreFiles = this.#normalizePaths(ignoreFiles || []);
        ignorePatterns = this.#normalizePaths(ignorePatterns || []);

        this.#normalizePaths(patterns).forEach(pattern => {
            const itemFiles = globSync(pattern, {ignore: ignorePatterns})
                .map(file => file.replaceAll('\\', '/'))
                .filter(file => !ignoreFiles.includes(file));

            files = files.concat(itemFiles);
        });

        return files;
    }

    /**
     * @param {string[]} patterns
     * @return {string[]}
     */
    #normalizePaths(patterns) {
        return patterns.map(item => this.basePath + '/' + item);
    }

    /**
     * @param {string} name
     * @param {string[]} files
     * @param {string[]} allFiles
     * @param {string[]} ignoreLibs
     * @param {string[]} ignoreFiles
     * @param {string[]} notBundledModules
     * @param {string[]|null} dependentOn
     * @param {boolean} [mapDependencies]
     * @param {string[]} libs
     * @return {{
     *     files: string[],
     *     depModules: string[],
     *     directDepModules: string[],
     * }}
     */
    #sortFiles(
        name,
        files,
        allFiles,
        ignoreLibs,
        ignoreFiles,
        notBundledModules,
        dependentOn,
        mapDependencies,
        libs
    ) {
        /** @var {Object.<string, string[]>} */
        const moduleDepsMap = {};
        const standalonePathList = [];
        let modules = [];
        const moduleFileMap = {};

        // All direct dependency modules, including dependency to this chunk.
        // To be filtered in the upper method call.
        const directDepModules = [];

        const ignoreModules = ignoreFiles.map(file => this.#obtainModuleName(file));

        allFiles.forEach(file => {
            const data = this.#obtainModuleData(file);

            const isTarget = files.includes(file);

            if (!data) {
                if (isTarget) {
                    standalonePathList.push(file);
                }

                return;
            }

            moduleDepsMap[data.name] = data.deps;
            moduleFileMap[data.name] = file;

            if (isTarget) {
                modules.push(data.name);
            }
        });

        const depModules = [];
        const allDepModules = [];

        modules
            .forEach(name => {
                const deps = this.#obtainAllDeps(name, moduleDepsMap);

                deps
                    .filter(item => !modules.includes(item))
                    .filter(item => !allDepModules.includes(item))
                    .forEach(item => allDepModules.push(item));

                deps
                    .filter(item => !item.includes('!'))
                    .filter(item => !modules.includes(item))
                    .filter(item => !depModules.includes(item))
                    .forEach(item => depModules.push(item));
            });

        modules = modules
            .concat(depModules)
            .filter(module => !ignoreModules.includes(module));

        /** @var {string[]} */
        const discardedModules = [];
        /** @var {Object.<string, number>} */
        const depthMap = {};
        /** @var {string[]} */
        const pickedModules = [];

        for (const module of modules) {
            this.#buildTreeItem(
                module,
                moduleDepsMap,
                depthMap,
                ignoreLibs,
                dependentOn,
                discardedModules,
                pickedModules
            );
        }

        if (dependentOn) {
            modules = pickedModules;
        }

        modules.sort((v1, v2) => {
            return depthMap[v2] - depthMap[v1];
        });

        discardedModules.forEach(item => notBundledModules.push(item));

        modules = modules.filter(item => !discardedModules.includes(item));


        for (const m of modules) {
            (moduleDepsMap[m] || [])
                .filter(it => !directDepModules.includes(it))
                .forEach(it => directDepModules.push(it));
        }

        let modulePaths = modules.map(name => {
            if (!moduleFileMap[name] && mapDependencies) {
                return null;
            }

            if (moduleFileMap[name]) {
                return moduleFileMap[name];
            }

            for (const item of libs) {
                const libId = item.amdId;

                if (libId && libId === name) {
                    return null;
                }
            }

            throw Error(`Can't obtain ${name}. Might be missing in lookupPatterns.`);
        });

        modulePaths = modulePaths.filter(path => path !== null);

        return {
            files: standalonePathList.concat(modulePaths),
            depModules: allDepModules,
            directDepModules: directDepModules,
        };
    }

    /**
     * @param {string} name
     * @param {Object.<string, string[]>} map
     * @param {string[]} [list]
     */
    #obtainAllDeps(name, map, list) {
        if (!list) {
            list = [];
        }

        const deps = map[name] || [];

        deps.forEach(depName => {
            if (!list.includes(depName)) {
                list.push(depName);
            }

            if (depName.includes('!')) {
                return;
            }

            this.#obtainAllDeps(depName, map, list);
        });

        return list;
    }

    /**
     * @param {string} module
     * @param {Object.<string, string[]>} map
     * @param {Object.<string, number>} depthMap
     * @param {string[]} ignoreLibs
     * @param {string[]} dependentOn
     * @param {string[]} discardedModules
     * @param {string[]} pickedModules
     * @param {number} [depth]
     * @param {string[]} [path]
     */
    #buildTreeItem(
        module,
        map,
        depthMap,
        ignoreLibs,
        dependentOn,
        discardedModules,
        pickedModules,
        depth,
        path
    ) {
        /** @var {string[]} */
        const deps = map[module] || [];
        depth = depth || 0;
        path = [].concat(path || []);

        path.push(module);

        if (!(module in depthMap)) {
            depthMap[module] = depth;
        }
        else if (depth > depthMap[module]) {
            depthMap[module] = depth;
        }

        if (deps.length === 0) {
            return;
        }

        /**
         * @param {string} depName
         * @return {boolean}
         */
        const isLib = depName => {
            if (depName.startsWith('lib!')) {
                depName = depName.slice(4);
            }

            return ignoreLibs.includes(depName);
        }

        /**
         * @param {string} depName
         * @return {boolean}
         */
        const isDependentOnMatched = depName => {
            if (!dependentOn) {
                return false;
            }

            if (depName.startsWith('lib!')) {
                depName = depName.slice(4);
            }

            return dependentOn.includes(depName);
        }

        for (const depName of deps) {
            if (isLib(depName)) {
                path
                    .filter(item => !discardedModules.includes(item))
                    .forEach(item => discardedModules.push(item));

                return;
            }

            if (isDependentOnMatched(depName)) {
                path
                    .filter(item => !pickedModules.includes(item))
                    .forEach(item => pickedModules.push(item));
            }
        }

        deps.forEach(depName => {
            if (isLib(depName)) {
                return;
            }

            this.#buildTreeItem(
                depName,
                map,
                depthMap,
                ignoreLibs,
                dependentOn,
                discardedModules,
                pickedModules,
                depth + 1,
                path
            );
        });
    }

    /**
     * @param {string} file
     * @return string
     */
    #obtainModuleName(file) {
        for (const mod in this.modPaths) {
            const part = this.basePath + '/' + this.modPaths[mod] + '/src/';

            if (file.indexOf(part) === 0) {
                return `modules/${mod}/` + file.substring(part.length, file.length - 3);
            }
        }

        return file.slice(this.#getSrcPath().length, -3);
    }

    /**
     * @param {string} path
     * @return {{deps: string[], name: string}|null}
     */
    #obtainModuleData(path) {
        if (!this.#isClientJsFile(path)) {
            return null;
        }

        const moduleName = this.#obtainModuleName(path);

        const sourceCode = fs.readFileSync(path, 'utf-8');

        const tsSourceFile = typescript.createSourceFile(
            path,
            sourceCode,
            typescript.ScriptTarget.Latest
        );

        const rootStatement = tsSourceFile.statements[0];

        if (
            !rootStatement.expression ||
            !rootStatement.expression.expression ||
            rootStatement.expression.expression.escapedText !== 'define'
        ) {
            if (!sourceCode.includes('export ')) {
                return null;
            }

            if (!sourceCode.includes('import ')) {
                return {
                    name: moduleName,
                    deps: [],
                };
            }

            return {
                name: moduleName,
                deps: this.#obtainModuleDeps(tsSourceFile, moduleName),
            };
        }

        const deps = [];

        const argumentList = rootStatement.expression.arguments;

        for (const argument of argumentList.slice(0, 2)) {
            if (argument.elements) {
                argument.elements.forEach(node => {
                    if (!node.text) {
                        return;
                    }

                    const dep = this.#normalizeModModuleId(node.text);

                    deps.push(dep);
                });
            }
        }

        return {
            name: moduleName,
            deps: deps,
        };
    }

    /**
     * @param {string} sourceFile
     * @param {string} subjectId
     * @return {string[]}
     */
    #obtainModuleDeps(sourceFile, subjectId) {
        return sourceFile.statements
            .filter(item => item.importClause && item.moduleSpecifier)
            .map(item => item.moduleSpecifier.text)
            .map(/** string */id => {
                id = this.#normalizeIdPath(id, subjectId);

                return this.#normalizeModModuleId(id);
            });
    }

    /**
     * @param {string} id
     * @param {string} subjectId
     * @private
     */
    #normalizeIdPath(id, subjectId) {
        if (id.at(0) !== '.') {
            return id;
        }

        if (id.slice(0, 2) !== './' && id.slice(0, 3) !== '../') {
            return id;
        }

        let outputPath = id;

        const dirParts = subjectId.split('/').slice(0, -1);

        if (id.slice(0, 2) === './') {
            outputPath = dirParts.join('/') + '/' + id.slice(2);
        }

        const parts = outputPath.split('/');

        let up = 0;

        for (const part of parts) {
            if (part === '..') {
                up++;

                continue;
            }

            break;
        }

        if (!up) {
            return outputPath;
        }

        if (up) {
            outputPath = dirParts.slice(0, -up).join('/') + '/' + outputPath.slice(3 * up);
        }

        return outputPath;
    }

    /**
     * @param {string} id
     * @return {string}
     */
    #normalizeModModuleId(id) {
        if (!id.includes(':')) {
            return id;
        }

        const [mod, part] = id.split(':');

        return `modules/${mod}/` + part;
    }

    /**
     * @param {string} path
     * @return {boolean}
     */
    #isClientJsFile(path) {
        if (path.slice(-3) !== '.js') {
            return false;
        }

        const startParts = [this.#getSrcPath()];

        for (const mod in this.modPaths) {
            const modPath = this.basePath + '/' + this.modPaths[mod] + '/src/';

            startParts.push(modPath);
        }

        for (const starPart of startParts) {
            if (path.indexOf(starPart) === 0) {
                return true;
            }
        }

        return false;
    }

    /**
     * @private
     * @param {string} path
     * @return {string}
     */
    #normalizeSourceFile(path) {
        let sourceCode = fs.readFileSync(path, 'utf-8');
        const srcPath = this.#getSrcPath();

        sourceCode = this.#stripSourceMappingUrl(sourceCode);

        if (!this.#isClientJsFile(path)) {
            return sourceCode;
        }

        if (!sourceCode.includes('define')) {
            return sourceCode;
        }

        const moduleName = path.slice(srcPath.length, -3);

        const tsSourceFile = typescript.createSourceFile(
            path,
            sourceCode,
            typescript.ScriptTarget.Latest
        );

        const rootStatement = tsSourceFile.statements[0];

        if (
            !rootStatement.expression ||
            !rootStatement.expression.expression ||
            rootStatement.expression.expression.escapedText !== 'define'
        ) {
            return sourceCode;
        }

        const argumentList = rootStatement.expression.arguments;

        if (argumentList.length >= 3 || argumentList.length === 0) {
            return sourceCode;
        }

        const moduleNameNode = typescript.createStringLiteral(moduleName);

        if (argumentList.length === 1) {
            argumentList.unshift(
                typescript.createArrayLiteral([])
            );
        }

        argumentList.unshift(moduleNameNode);

        return typescript.createPrinter().printFile(tsSourceFile);
    }

    /**
     * @param {string} contents
     * @return {string}
     */
    #stripSourceMappingUrl(contents) {
        const re = /^\/\/# sourceMappingURL.*/gm;

        if (!contents.match(re)) {
            return contents;
        }

        return contents.replaceAll(re, '');
    }

    /**
     * @return {string}
     */
    #getSrcPath() {
        let path = this.srcPath;

        if (path.slice(-1) !== '/') {
            path += '/';
        }

        return path;
    }
}

module.exports = Bundler;
