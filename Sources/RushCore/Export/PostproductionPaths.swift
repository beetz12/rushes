import Foundation

enum PostproductionPaths {
    static func file(_ name:String,in folder:URL,requireExists:Bool = true) throws -> URL {
        guard !name.isEmpty,name != ".",name != "..",!name.contains("/"),!name.contains("\\") else { throw renderFailure("Unsafe package filename: \(name)") }
        let root=folder.resolvingSymlinksInPath(),url=root.appendingPathComponent(name).resolvingSymlinksInPath()
        guard url.deletingLastPathComponent() == root else { throw renderFailure("Package file escapes its folder: \(name)") }
        if requireExists && !FileManager.default.fileExists(atPath:url.path) { throw renderFailure("Missing package file: \(name)") }
        return url
    }
    /// Cache directories are owned by this package, never linked into another
    /// location. Revalidate them before reads, writes, finalize and cleanup.
    static func managedDirectory(_ name:String,in folder:URL,create:Bool = false) throws -> URL {
        let root=folder.resolvingSymlinksInPath()
        let expected=root.appendingPathComponent(name,isDirectory:true)
        let checked=try file(name,in:root,requireExists:false)
        guard checked.standardizedFileURL.path == expected.standardizedFileURL.path else { throw renderFailure("Managed directory must not be a symbolic link: \(name)") }
        if create && !FileManager.default.fileExists(atPath:expected.path) { try FileManager.default.createDirectory(at:expected,withIntermediateDirectories:false) }
        var isDirectory:ObjCBool=false
        guard FileManager.default.fileExists(atPath:expected.path,isDirectory:&isDirectory),isDirectory.boolValue,
              expected.resolvingSymlinksInPath().standardizedFileURL.path == expected.standardizedFileURL.path else { throw renderFailure("Invalid managed directory: \(name)") }
        return expected
    }
    static func managedFile(_ name:String,in directory:URL) throws -> URL {
        // Normalize the parent first: Foundation can represent the same macOS
        // temporary directory using /var or /private/var aliases.
        let canonical=directory.resolvingSymlinksInPath()
        let expected=canonical.appendingPathComponent(name)
        let resolved=try file(name,in:canonical,requireExists:false)
        guard resolved.standardizedFileURL.path == expected.standardizedFileURL.path else { throw renderFailure("Managed cache file must not be a symbolic link: \(name)") }
        return expected
    }

}
