/**
 * @fileoverview Utilities for working with globs and the filesystem.
 * @author Ian VanSchooten
 */
"use strict";

//------------------------------------------------------------------------------
// Requirements
//------------------------------------------------------------------------------

const lodash = require("lodash"),
    fs = require("fs"),
    path = require("path"),
    GlobSync = require("./glob"),

    pathUtil = require("./path-util"),
    IgnoredPaths = require("../ignored-paths");

const debug = require("debug")("eslint:glob-util");

//------------------------------------------------------------------------------
// Helpers
//------------------------------------------------------------------------------

/**
 * Checks if a provided path is a directory and returns a glob string matching
 * all files under that directory if so, the path itself otherwise.
 *
 * Reason for this is that `glob` needs `/**` to collect all the files under a
 * directory where as our previous implementation without `glob` simply walked
 * a directory that is passed. So this is to maintain backwards compatibility.
 *
 * Also makes sure all path separators are POSIX style for `glob` compatibility.
 *
 * @param {Object}   [options]                    An options object
 * @param {string[]} [options.extensions=[".js"]] An array of accepted extensions
 * @param {string}   [options.cwd=process.cwd()]  The cwd to use to resolve relative pathnames
 * @returns {Function} A function that takes a pathname and returns a glob that
 *                     matches all files with the provided extensions if
 *                     pathname is a directory.
 */
function processPath(options) {
    const cwd = (options && options.cwd) || process.cwd();
    let extensions = (options && options.extensions) || [".js"];

    extensions = extensions.map(ext => ext.replace(/^\./, ""));

    let suffix = "/**";

    if (extensions.length === 1) {
        suffix += `/*.${extensions[0]}`;
    } else {
        suffix += `/*.{${extensions.join(",")}}`;
    }

    /**
     * A function that converts a directory name to a glob pattern
     *
     * @param {string} pathname The directory path to be modified
     * @returns {string} The glob path or the file path itself
     * @private
     */
    return function(pathname) {
        let newPath = pathname;
        const resolvedPath = path.resolve(cwd, pathname);

        if (fs.existsSync(resolvedPath) && fs.statSync(resolvedPath).isDirectory()) {
            newPath = pathname.replace(/[/\\]$/, "") + suffix;
        }

        return pathUtil.convertPathToPosix(newPath);
    };
}

//------------------------------------------------------------------------------
// Public Interface
//------------------------------------------------------------------------------

/**
 * Resolves any directory patterns into glob-based patterns for easier handling.
 * @param   {string[]} patterns    File patterns (such as passed on the command line).
 * @param   {Object} options       An options object.
 * @returns {string[]} The equivalent glob patterns and filepath strings.
 */
function resolveFileGlobPatterns(patterns, options) {

    const processPathExtensions = processPath(options);

    return patterns.filter(p => p.length).map(processPathExtensions);
}

const dotfilesPattern = /(?:(?:^\.)|(?:[/\\]\.))[^/\\.].*/;

/**
 * Build a list of absolute filesnames on which ESLint will act.
 * Ignored files are excluded from the results, as are duplicates.
 *
 * @param   {string[]} globPatterns                    Glob patterns.
 * @param   {Object}   [providedOptions]               An options object.
 * @param   {string}   [providedOptions.cwd]           CWD (considered for relative filenames)
 * @param   {boolean}  [providedOptions.ignore]        False disables use of .eslintignore.
 * @param   {string}   [providedOptions.ignorePath]    The ignore file to use instead of .eslintignore.
 * @param   {string}   [providedOptions.ignorePattern] A pattern of files to ignore.
 * @returns {string[]} Resolved absolute filenames.
 */
function listFilesToProcess(globPatterns, providedOptions) {
    const options = providedOptions || { ignore: true };
    const files = [];
    const addedFilenames = new Set();

    const cwd = options.cwd || process.cwd();

    const getIgnorePaths = lodash.memoize(
        optionsObj =>
            new IgnoredPaths(optionsObj)
    );

    /**
     * Executes the linter on a file defined by the `filename`. Skips
     * any files that are already linted.
     * @param {string} filename The file to be processed
     * @param {boolean} isDirectPath True if the file
     * was provided as a direct path (as opposed to being resolved from a glob)
     * @param {IgnoredPaths} ignoredPaths An instance of IgnoredPaths
     * @returns {void}
     */
    function addFile(filename, isDirectPath, ignoredPaths) {
        if (addedFilenames.has(filename)) {
            return;
        }

        const shouldProcessCustomIgnores = options.ignore !== false;
        const shouldLintIgnoredDirectPaths = options.ignore === false;
        const fileMatchesIgnorePatterns = ignoredPaths.contains(filename, "default") ||
            (shouldProcessCustomIgnores && ignoredPaths.contains(filename, "custom"));

        if (fileMatchesIgnorePatterns && isDirectPath && !shouldLintIgnoredDirectPaths) {
            files.push({ filename, ignored: true });
            addedFilenames.add(filename);
        }

        if (!fileMatchesIgnorePatterns || (isDirectPath && shouldLintIgnoredDirectPaths)) {
            files.push({ filename, ignored: false });
            addedFilenames.add(filename);
        }
    }

    debug("Creating list of files to process.");
    globPatterns.forEach(pattern => {
        const file = path.resolve(cwd, pattern);

        if (fs.existsSync(file) && fs.statSync(file).isFile()) {
            const ignoredPaths = getIgnorePaths(options);

            addFile(fs.realpathSync(file), true, ignoredPaths);
        } else {

            // regex to find .hidden or /.hidden patterns, but not ./relative or ../relative
            const globIncludesDotfiles = dotfilesPattern.test(pattern);
            let newOptions = options;

            if (!options.dotfiles) {
                newOptions = Object.assign({}, options, { dotfiles: globIncludesDotfiles });
            }

            const ignoredPaths = getIgnorePaths(newOptions);
            const shouldIgnore = ignoredPaths.getIgnoredFoldersGlobChecker();
            const globOptions = {
                nodir: true,
                dot: true,
                cwd
            };

            new GlobSync(pattern, globOptions, shouldIgnore).found.forEach(globMatch => {
                addFile(path.resolve(cwd, globMatch), false, ignoredPaths);
            });
        }
    });

    return files;
}

module.exports = {
    resolveFileGlobPatterns,
    listFilesToProcess
};
