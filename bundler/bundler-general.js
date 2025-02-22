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

const Bundler = require("./bundler");
const Precompiler = require('./template-precompiler');

class BundlerGeneral {

    /**
     * @param {{
     *   basePath?: string,
     *   transpiledPath?: string,
     *   chunks: Object.<string, {
     *     files?: string[],
     *     patterns?: string[],
     *     ignorePatterns: string[],
     *     ignoreFiles?: string[],
     *     lookupPatterns?: string[],
     *     templatePatterns?: string[],
     *     noDuplicates?: boolean,
     *     dependentOn?: string[],
     *     requires?: string[],
     *     mapDependencies?: boolean,
     *   }>,
     *   modulePaths?: Record.<string, string>,
     *   lookupPatterns: string[],
     *   order: string[],
     * }} config
     * @param {{
     *    src?: string,
     *    bundle?: boolean,
     *    amdId?: string,
     *    files?: {
     *        src: string,
     *    }[]
     *  }[]} [libs]
     *  @param {string} [filePattern]
     */
    constructor(config, libs, filePattern) {
        this.config = config;
        this.libs = libs ?? [];
        this.mainBundleFiles = [];
        this.filePattern = filePattern || 'client/lib/espo-{*}.js';

        if (!this.config.order.length) {
            throw new Error(`No chunks specified in 'order' param.`);
        }
    }

    // noinspection JSUnusedGlobalSymbols
    /**
     * @return {Object.<string, string>}
     */
    bundle() {
        const result = {};
        const mapping = {};
        let files = [];
        let modules = [];
        let templateFiles = [];
        const mainName = this.config.order[0];

        /** @var {Object.<string, string[]>} */
        const notBundledMap = {};
        /** @var {Object.<string, string>} */
        const moduleChunkMap = {};
        /** @var {Object.<string, string[]>} */
        const chunkDirectDependentModulesMap = {};

        this.config.order.forEach((name, i) => {
            const data = this.#bundleChunk(name, i === 0, {
                files: files,
                templateFiles: templateFiles,
            });

            files = files.concat(data.files);
            templateFiles = templateFiles.concat(data.templateFiles);
            modules = modules.concat(data.modules);
            notBundledMap[name] = data.notBundledModules;
            result[name] = data.contents;

            console.log(`  Chunk '${name}' done, ${data.files.length} files.`)

            chunkDirectDependentModulesMap[name] = data.directDependencyModules;

            if (i > 0) {
                for (const m of data.modules) {
                    moduleChunkMap[m] = name;
                }
            }

            if (i === 0 && this.config.order.length > 1) {
                return;
            }

            data.modules.forEach(item => mapping[item] = name);

            const bundleFile = this.filePattern.replace('{*}', name);

            let requires = [].concat(this.config.chunks[name].requires ?? []);

            if (this.config.chunks[name].mapDependencies) {
                requires = requires.concat(data.dependencyModules);
            }

            if (requires.length) {
                const part = JSON.stringify(requires);

                result[mainName] += `Espo.loader.mapBundleDependencies('${name}', ${part});\n`;
            }

            result[mainName] += `Espo.loader.mapBundleFile('${name}', '${bundleFile}');\n`;
        });

        this.config.order.slice(1).forEach(name => {
            const dependsOnChunks = [];
            const deps = [];

            for (const m of chunkDirectDependentModulesMap[name]) {
                const dependeeChunk = moduleChunkMap[m];

                if (!dependeeChunk) {
                    continue;
                }

                deps.push(m);

                if (!dependsOnChunks.includes(dependeeChunk)) {
                    dependsOnChunks.push(dependeeChunk);
                }
            }

            if (dependsOnChunks.length) {
                const part = dependsOnChunks.map(it => `'${it}'`).join(', ');

                console.warn(`\nWarning: Chunk '${name}' depends on chunk(s) ${part}.`);
                console.log('Depends on:');
                console.log(deps);

                console.log('\nRecommended to fix.');
            }
        });

        const notBundledModules = [];

        this.config.order.forEach(name => {
            notBundledMap[name]
                .filter(item => !modules.includes(item))
                .filter(item => !notBundledModules.includes(item))
                .forEach(item => notBundledModules.push(item));
        });

        if (notBundledModules.length) {
            const part = notBundledModules
                .map(item => ' ' + item)
                .join('\n');

            console.log(`\nNot bundled:\n${part}`);
        }

        result[mainName] += `Espo.loader.addBundleMapping(${JSON.stringify(mapping)});`

        return result;
    }

    /**
     * @param {string} name
     * @param {boolean} isMain
     * @param {{files: [], templateFiles: []}} alreadyBundled
     * @return {{
     *   contents: string,
     *   modules: string[],
     *   files: string[],
     *   templateFiles: string[],
     *   notBundledModules: string[],
     *   dependencyModules: [],
     *   directDependencyModules: string[],
     * }}
     */
    #bundleChunk(name, isMain, alreadyBundled) {
        let contents = '';
        let modules = [];
        let dependencyModules = [];
        let directDependencyModules = [];

        const params = this.config.chunks[name];

        const patterns = params.patterns;

        const lookupPatterns = []
            .concat(this.config.lookupPatterns)
            .concat(params.lookupPatterns || []);

        let bundledFiles = [];
        let bundledTemplateFiles = [];
        let notBundledModules = [];

        if (params.patterns) {
            const bundler = new Bundler(
                this.config.modulePaths,
                this.config.basePath,
                this.config.transpiledPath
            );

            // The main bundle is always loaded, duplicates are not needed.
            let ignoreFiles = [].concat(this.mainBundleFiles);

            if (params.noDuplicates) {
                ignoreFiles = ignoreFiles.concat(alreadyBundled.files);
            }

            const data = bundler.bundle({
                name: name,
                files: params.files,
                patterns: patterns,
                ignorePatterns: params.ignorePatterns,
                lookupPatterns: lookupPatterns,
                libs: this.libs,
                ignoreFullPathFiles: ignoreFiles,
                ignoreFiles: params.ignoreFiles,
                dependentOn: params.dependentOn,
                mapDependencies: params.mapDependencies,
            });

            contents += data.contents;

            if (isMain) {
                this.mainBundleFiles = data.files;
            }

            modules = data.modules;
            bundledFiles = data.files;

            notBundledModules = data.notBundledModules;
            dependencyModules = data.dependencyModules;
            directDependencyModules = data.directDependencyModules;
        }

        // Pre-compiled templates turned out to be slower if too many are bundled.
        // To be used sparingly.
        if (params.templatePatterns) {
            const ignoreFiles = params.noDuplicates ? [].concat(alreadyBundled.templateFiles) : [];

            const data = (new Precompiler()).precompile({
                patterns: params.templatePatterns,
                modulePaths: this.config.modulePaths,
                ignoreFiles: ignoreFiles,
            });

            contents += '\n' + data.contents;
            bundledTemplateFiles = data.files;
        }

        return {
            contents: contents,
            modules: modules,
            files: bundledFiles,
            templateFiles: bundledTemplateFiles,
            notBundledModules: notBundledModules,
            dependencyModules: dependencyModules,
            directDependencyModules: directDependencyModules,
        };
    }
}

module.exports = BundlerGeneral;
