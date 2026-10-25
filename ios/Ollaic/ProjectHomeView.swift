import SwiftUI

struct ProjectHomeView: View {
    var body: some View {
        NavigationStack {
            ContentUnavailableView("No Projects", systemImage: "folder")
                .navigationTitle("Ollaic")
        }
    }
}

#Preview {
    ProjectHomeView()
}
