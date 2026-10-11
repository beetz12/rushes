import Foundation

enum PostproductionPaths {
    static func file(_ name:String,in folder:URL,requireExists:Bool = true) throws -> URL {
        guard !name.isEmpty,name != ".",name != "..",!name.contains("/"),!name.contains("\\") else { throw renderFailure("Unsafe package filename: \(name)") }
        let root=folder.resolvingSymlinksInPath(),url=root.appendingPathComponent(name).resolvingSymlinksInPath()
        guard url.deletingLastPathComponent() == root else { throw renderFailure("Package file escapes its folder: \(name)") }
        if requireExists && !FileManager.default.fileExists(atPath:url.path) { throw renderFailure("Missing package file: \(name)") }
        return url
    }
}
