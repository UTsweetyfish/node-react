import {dirname, extname, join, normalize, resolve, sep} from 'path';
import builtins from 'builtin-modules';
import resolveId from 'resolve';
import isModule from 'is-module';
import fs from 'fs';

const ES6_BROWSER_EMPTY = resolve( __dirname, '../src/empty.js' );
// It is important that .mjs occur before .js so that Rollup will interpret npm modules
// which deploy both ESM .mjs and CommonJS .js files as ESM.
const DEFAULT_EXTS = [ '.mjs', '.js', '.json', '.node' ];

const readFileAsync = file => new Promise((fulfil, reject) => fs.readFile(file, (err, contents) => err ? reject(err) : fulfil(contents)));
const statAsync = file => new Promise((fulfil, reject) => fs.stat(file, (err, contents) => err ? reject(err) : fulfil(contents)));
const cache = fn => {
	const cache = new Map();
	const wrapped = (param, done) => {
		if (cache.has(param) === false) {
			cache.set(param, fn(param).catch(err => {
				cache.delete(param);
				throw err;
			}));
		}
		return cache.get(param).then(result => done(null, result), done);
	};
	wrapped.clear = () => cache.clear();
	return wrapped;
};
const ignoreENOENT = err => {
	if (err.code === 'ENOENT') return false;
	throw err;
};
const readFileCached = cache(readFileAsync);
const isDirCached = cache(file => statAsync(file).then(stat => stat.isDirectory(), ignoreENOENT));
const isFileCached = cache(file => statAsync(file).then(stat => stat.isFile(), ignoreENOENT));

function getMainFields (options) {
	let mainFields;
	if (options.mainFields) {
		if ('module' in options || 'main' in options || 'jsnext' in options) {
			throw new Error(`node-resolve: do not use deprecated 'module', 'main', 'jsnext' options with 'mainFields'`);
		}
		mainFields = options.mainFields;
	} else {
		mainFields = [];
		[['module', 'module', true], ['jsnext', 'jsnext:main', false], ['main', 'main', true]].forEach(([option, field, defaultIncluded]) => {
			if (option in options) {
				// eslint-disable-next-line no-console
				console.warn(`node-resolve: setting options.${option} is deprecated, please override options.mainFields instead`);
				if (options[option]) {
					mainFields.push(field);
				}
			} else if (defaultIncluded) {
				mainFields.push(field);
			}
		});
	}
	if (options.browser && mainFields.indexOf('browser') === -1) {
		return ['browser'].concat(mainFields);
	}
	if ( !mainFields.length ) {
		throw new Error( `Please ensure at least one 'mainFields' value is specified` );
	}
	return mainFields;
}

const resolveIdAsync = (file, opts) => new Promise((fulfil, reject) => resolveId(file, opts, (err, contents) => err ? reject(err) : fulfil(contents)));

export default function nodeResolve ( options = {} ) {
	const mainFields = getMainFields(options);
	const useBrowserOverrides = mainFields.indexOf('browser') !== -1;
	const dedupe = options.dedupe || [];
	const isPreferBuiltinsSet = options.preferBuiltins === true || options.preferBuiltins === false;
	const preferBuiltins = isPreferBuiltinsSet ? options.preferBuiltins : true;
	const customResolveOptions = options.customResolveOptions || {};
	const jail = options.jail;
	const only = Array.isArray(options.only)
		? options.only.map(o => o instanceof RegExp
			? o
			: new RegExp('^' + String(o).replace(/[\\^$*+?.()|[\]{}]/g, '\\$&') + '$')
		)
		: null;
	const browserMapCache = {};

	if ( options.skip ) {
		throw new Error( 'options.skip is no longer supported — you should use the main Rollup `external` option instead' );
	}

	let preserveSymlinks;

	return {
		name: 'node-resolve',

		options ( options ) {
			preserveSymlinks = options.preserveSymlinks;
		},

		generateBundle () {
			readFileCached.clear();
			isFileCached.clear();
			isDirCached.clear();
		},

		resolveId ( importee, importer ) {
			if ( /\0/.test( importee ) ) return null; // ignore IDs with null character, these belong to other plugins

			const basedir = importer ? dirname( importer ) : process.cwd();

			if (dedupe.indexOf(importee) !== -1) {
				importee = join(process.cwd(), 'node_modules', importee);
			}

			// https://github.com/defunctzombie/package-browser-field-spec
			if (useBrowserOverrides && browserMapCache[importer]) {
				const resolvedImportee = resolve( basedir, importee );
				const browser = browserMapCache[importer];
				if (browser[importee] === false || browser[resolvedImportee] === false) {
					return ES6_BROWSER_EMPTY;
				}
				if (browser[importee] || browser[resolvedImportee] || browser[resolvedImportee + '.js'] || browser[resolvedImportee + '.json']) {
					importee = browser[importee] || browser[resolvedImportee] || browser[resolvedImportee + '.js'] || browser[resolvedImportee + '.json'];
				}
			}

			const parts = importee.split( /[/\\]/ );
			let id = parts.shift();

			if ( id[0] === '@' && parts.length ) {
				// scoped packages
				id += `/${parts.shift()}`;
			} else if ( id[0] === '.' ) {
				// an import relative to the parent dir of the importer
				id = resolve( basedir, importee );
			}

			if (only && !only.some(pattern => pattern.test(id))) return null;

			let disregardResult = false;
			let packageBrowserField = false;
			const extensions = options.extensions || DEFAULT_EXTS;

			const resolveOptions = {
				basedir,
				packageFilter ( pkg, pkgPath ) {
					const pkgRoot = dirname( pkgPath );
					if (useBrowserOverrides && typeof pkg[ 'browser' ] === 'object') {
						packageBrowserField = Object.keys(pkg[ 'browser' ]).reduce((browser, key) => {
							let resolved = pkg[ 'browser' ][ key ];
							if (resolved && resolved[0] === '.') {
								resolved = resolve( pkgRoot, pkg[ 'browser' ][ key ] );
							}
							browser[ key ] = resolved;
							if ( key[0] === '.' ) {
								const absoluteKey = resolve( pkgRoot, key );
								browser[ absoluteKey ] = resolved;
								if ( !extname(key) ) {
									extensions.reduce( ( browser, ext ) => {
										browser[ absoluteKey + ext ] = browser[ key ];
										return browser;
									}, browser );
								}
							}
							return browser;
						}, {});
					}

					let overriddenMain = false;
					for ( let i = 0; i < mainFields.length; i++ ) {
						const field = mainFields[i];
						if ( typeof pkg[ field ] === 'string' ) {
							pkg[ 'main' ] = pkg[ field ];
							overriddenMain = true;
							break;
						}
					}
					if ( overriddenMain === false && mainFields.indexOf( 'main' ) === -1 ) {
						disregardResult = true;
					}
					return pkg;
				},
				readFile: readFileCached,
				isFile: isFileCached,
				isDirectory: isDirCached,
				extensions: extensions
			};

			if (preserveSymlinks !== undefined) {
				resolveOptions.preserveSymlinks = preserveSymlinks;
			}

			return resolveIdAsync(
				importee,
				Object.assign( resolveOptions, customResolveOptions )
			)
				.then(resolved => {
					if ( resolved && useBrowserOverrides && packageBrowserField ) {
						if ( packageBrowserField.hasOwnProperty(resolved) ) {
							if (!packageBrowserField[resolved]) {
								browserMapCache[resolved] = packageBrowserField;
								return ES6_BROWSER_EMPTY;
							}
							resolved = packageBrowserField[ resolved ];
						}
						browserMapCache[resolved] = packageBrowserField;
					}

					if ( !disregardResult ) {
						if ( !preserveSymlinks && resolved && fs.existsSync( resolved ) ) {
							resolved = fs.realpathSync( resolved );
						}

						if ( ~builtins.indexOf( resolved ) ) {
							return null;
						} else if ( ~builtins.indexOf( importee ) && preferBuiltins ) {
							if ( !isPreferBuiltinsSet ) {
								this.warn(
									`preferring built-in module '${importee}' over local alternative ` +
									`at '${resolved}', pass 'preferBuiltins: false' to disable this ` +
									`behavior or 'preferBuiltins: true' to disable this warning`
								);
							}
							return null;
						} else if ( jail && resolved.indexOf( normalize( jail.trim( sep ) ) ) !== 0 ) {
							return null;
						}
					}

					if ( resolved && options.modulesOnly ) {
						return readFileAsync( resolved, 'utf-8').then(code => isModule( code ) ? resolved : null);
					} else {
						return resolved;
					}
				})
				.catch(() => null);
		}
	};
}
