import Foundation

struct NativeAssetReferences {
    let prefix: String

    init(asset: AssetInfo) throws {
        prefix = try assetReferencePrefix(category: asset.category, name: asset.name)
    }

    func relativeName(_ value: String) -> String {
        guard !prefix.isEmpty else { return value }
        var name = value
        if name.hasPrefix("reference/") { name = String(name.dropFirst("reference/".count)) }
        if name.hasPrefix(prefix) { name = String(name.dropFirst(prefix.count)) }
        return name
    }

    func assetName(_ value: String) -> String { prefix + relativeName(value) }

    func normalized(_ values: [String]) -> [String] {
        var seen = Set<String>()
        return values.map(relativeName).filter { seen.insert($0).inserted }
    }
}

func matchingNativeAssets(_ assets: [AssetInfo], category: String, prefix: String = "", query: String = "") -> [AssetInfo] {
    assets.filter {
        $0.category == category && $0.name.hasPrefix(prefix)
            && (query.isEmpty || $0.name.localizedStandardContains(query) || $0.alias.localizedStandardContains(query))
    }
}
