import SwiftUI

private enum LibraryFilter: String, CaseIterable, Identifiable {
    case all, recent, favorites, trash
    var id: String { rawValue }

    var title: String {
        switch self {
        case .all: String(localized: "All Projects")
        case .recent: String(localized: "Recently Edited")
        case .favorites: String(localized: "Favorites")
        case .trash: String(localized: "Trash")
        }
    }

    var shortTitle: String {
        switch self {
        case .all: String(localized: "All")
        case .recent: String(localized: "Recent")
        default: title
        }
    }

    var symbol: String {
        switch self {
        case .all: "folder"
        case .recent: "clock"
        case .favorites: "star"
        case .trash: "trash"
        }
    }

    var emptyTitle: String {
        switch self {
        case .all: String(localized: "No Projects")
        case .recent: String(localized: "No Recent Projects")
        case .favorites: String(localized: "No Favorites")
        case .trash: String(localized: "Trash Is Empty")
        }
    }
}

private enum EditorRoute: Identifiable {
    case create, edit(LocalProject)
    var id: String { project?.id.uuidString ?? "create" }
    var project: LocalProject? {
        if case .edit(let project) = self { return project }
        return nil
    }
}

private enum ProjectConfirmation {
    case trash(LocalProject), delete(LocalProject), emptyTrash

    var title: String {
        switch self {
        case .trash: String(localized: "Move to Trash?")
        case .delete: String(localized: "Delete Project Permanently?")
        case .emptyTrash: String(localized: "Empty Trash?")
        }
    }

    var name: String {
        switch self {
        case .trash(let project), .delete(let project): project.name
        case .emptyTrash: String(localized: "All projects in Trash will be permanently deleted.")
        }
    }
}

@MainActor
struct ProjectHomeView: View {
    @Environment(ProjectLibrary.self) private var library
    @Environment(\.horizontalSizeClass) private var sizeClass
    @Environment(\.dynamicTypeSize) private var dynamicTypeSize
    @AppStorage("home.layout") private var layout = "grid"
    @AppStorage("home.sort") private var sort = "modified"
    @State private var filter: LibraryFilter = .all
    @State private var query = ""
    @State private var path: [UUID] = []
    @State private var editor: EditorRoute?
    @State private var confirmation: ProjectConfirmation?
    @State private var actionError: String?
    @State private var columnVisibility: NavigationSplitViewVisibility = .all

    private var visibleProjects: [LocalProject] {
        var projects = library.projects.filter { project in
            switch filter {
            case .all, .recent: !project.isDeleted
            case .favorites: project.isFavorite && !project.isDeleted
            case .trash: project.isDeleted
            }
        }
        projects.sort {
            if filter == .trash { return ($0.deletedAt ?? .distantPast) > ($1.deletedAt ?? .distantPast) }
            if filter == .recent || sort == "modified" {
                return $0.lastActivity == $1.lastActivity ? $0.id.uuidString < $1.id.uuidString : $0.lastActivity > $1.lastActivity
            }
            if sort == "name" { return $0.name.localizedStandardCompare($1.name) == .orderedAscending }
            return $0.createdAt > $1.createdAt
        }
        if filter == .recent { projects = Array(projects.prefix(5)) }
        let query = query.trimmingCharacters(in: .whitespacesAndNewlines)
        return query.isEmpty ? projects : projects.filter {
            $0.name.localizedStandardContains(query) || $0.synopsis.localizedStandardContains(query)
        }
    }

    var body: some View {
        Group {
            if sizeClass == .regular {
                NavigationSplitView(columnVisibility: $columnVisibility) {
                    List(selection: Binding<LibraryFilter?>(get: { filter }, set: { if let value = $0 { filter = value } })) {
                        Section("Project Library") {
                            ForEach(LibraryFilter.allCases) { item in
                                Label(item.title, systemImage: item.symbol)
                                    .badge(projectCount(for: item))
                                    .tag(item)
                                    .accessibilityIdentifier("filter-\(item.rawValue)")
                            }
                        }
                    }
                    .navigationTitle("Ollaic")
                    .navigationSplitViewColumnWidth(min: 220, ideal: 260, max: 300)
                } detail: { navigation }
            } else {
                navigation
            }
        }
        .task { await library.load() }
        .sheet(item: $editor) { route in
            ProjectEditorSheet(project: route.project) { _ in
                if route.project == nil { filter = .all; query = "" }
            }
        }
        .confirmationDialog(confirmation?.title ?? "", isPresented: Binding(
            get: { confirmation != nil }, set: { if !$0 { confirmation = nil } }
        ), titleVisibility: .visible) {
            if let pending = confirmation {
                switch pending {
                case .trash(let project):
                    Button("Move to Trash", role: .destructive) { perform { try await library.moveToTrash(project.id) } }
                case .delete(let project):
                    Button("Delete Permanently", role: .destructive) { perform { try await library.deletePermanently(project.id) } }
                case .emptyTrash:
                    Button("Empty Trash", role: .destructive) { perform { try await library.emptyTrash() } }
                }
            }
            Button("Cancel", role: .cancel) {}
        } message: { Text(confirmation?.name ?? "") }
        .alert("Couldn't Save Changes", isPresented: Binding(
            get: { actionError != nil }, set: { if !$0 { actionError = nil } }
        )) {
            Button("OK", role: .cancel) { actionError = nil }
        } message: { Text(actionError ?? "") }
        .onChange(of: filter) { _, _ in path.removeAll() }
        .onChange(of: path) { _, value in
            if sizeClass == .regular { columnVisibility = value.isEmpty ? .all : .detailOnly }
        }
    }

    private var navigation: some View {
        NavigationStack(path: $path) {
            libraryContent
                .background(Color(uiColor: .systemGroupedBackground))
                .navigationTitle(sizeClass == .regular ? filter.title : "Ollaic")
                .searchable(text: $query, placement: .navigationBarDrawer(displayMode: .always), prompt: "Search Projects")
                .scrollDismissesKeyboard(.interactively)
                .navigationDestination(for: UUID.self) { id in
                    if library.project(id)?.isDeleted == false {
                        ProjectWorkspaceView(projectID: id)
                    } else {
                        ProjectDetailView(projectID: id)
                    }
                }
                .toolbar {
                    ToolbarItem(placement: .primaryAction) {
                        Button("New Project", systemImage: "plus") { editor = .create }
                            .disabled(!library.isLoaded || library.isSaving)
                            .accessibilityIdentifier("new-project")
                            .help("New Project")
                    }
                    ToolbarItem(placement: .topBarTrailing) {
                        Menu {
                            Picker("View", selection: $layout) {
                                Label("Grid", systemImage: "square.grid.2x2").tag("grid")
                                Label("List", systemImage: "list.bullet").tag("list")
                            }
                            Picker("Sort By", selection: $sort) {
                                Text("Last Modified").tag("modified")
                                Text("Name").tag("name")
                                Text("Date Created").tag("created")
                            }
                            .disabled(filter == .recent || filter == .trash)
                            if filter == .trash && projectCount(for: .trash) > 0 {
                                Divider()
                                Button("Empty Trash", systemImage: "trash", role: .destructive) { confirmation = .emptyTrash }
                                    .disabled(library.isSaving)
                            }
                        } label: { Label("View Options", systemImage: "ellipsis.circle") }
                        .accessibilityIdentifier("view-options")
                        .help("View Options")
                    }
                }
        }
    }

    @ViewBuilder private var libraryContent: some View {
        if let error = library.loadError {
            ContentUnavailableView {
                Label("Couldn't Load Projects", systemImage: "exclamationmark.triangle")
            } description: { Text(error) } actions: {
                Button("Retry") { Task { await library.load() } }
            }
        } else if !library.isLoaded {
            ProgressView().frame(maxWidth: .infinity, maxHeight: .infinity)
        } else if layout == "list" {
            List {
                header.listRowBackground(Color.clear).listRowSeparator(.hidden)
                if visibleProjects.isEmpty {
                    emptyState.listRowBackground(Color.clear).listRowSeparator(.hidden)
                } else {
                    ForEach(visibleProjects) { project in
                        NavigationLink(value: project.id) { ProjectListRow(project: project) }
                            .accessibilityIdentifier("project-item-\(project.id)")
                            .contextMenu { projectActions(project) }
                            .swipeActions(edge: .trailing, allowsFullSwipe: false) {
                                Button(role: .destructive) {
                                    confirmation = project.isDeleted ? .delete(project) : .trash(project)
                                } label: { Label(project.isDeleted ? String(localized: "Delete Permanently") : String(localized: "Move to Trash"), systemImage: "trash") }
                                if !project.isDeleted {
                                    Button("Edit", systemImage: "pencil") { editor = .edit(project) }.tint(.blue)
                                }
                            }
                            .swipeActions(edge: .leading) {
                                if project.isDeleted {
                                    Button("Restore", systemImage: "arrow.uturn.backward") { perform { try await library.restore(project.id) } }.tint(.teal)
                                } else {
                                    Button(project.isFavorite ? String(localized: "Unfavorite") : String(localized: "Favorite"), systemImage: "star") {
                                        perform { try await library.toggleFavorite(project.id) }
                                    }.tint(.yellow)
                                }
                            }
                            .disabled(library.isSaving)
                    }
                }
            }
            .listStyle(.plain)
            .scrollContentBackground(.hidden)
            .accessibilityIdentifier("project-list")
        } else {
            ScrollView {
                VStack(alignment: .leading, spacing: 24) {
                    header
                    if visibleProjects.isEmpty {
                        emptyState
                    } else {
                        LazyVGrid(columns: [GridItem(.adaptive(minimum: dynamicTypeSize.isAccessibilitySize ? 280 : (sizeClass == .regular ? 200 : 150)), spacing: 14)], spacing: 16) {
                            ForEach(visibleProjects) { project in
                                NavigationLink(value: project.id) { ProjectCard(project: project) }
                                    .buttonStyle(.plain)
                                    .accessibilityElement(children: .combine)
                                    .accessibilityIdentifier("project-item-\(project.id)")
                                    .contextMenu { projectActions(project) }
                                    .overlay(alignment: .topTrailing) {
                                        Menu { projectActions(project) } label: {
                                            Image(systemName: "ellipsis")
                                                .font(.body.weight(.semibold))
                                                .foregroundStyle(.secondary)
                                                .frame(width: 44, height: 44)
                                                .contentShape(Rectangle())
                                        }
                                        .accessibilityLabel(String(localized: "Actions for \(project.name)"))
                                        .accessibilityIdentifier("project-actions-\(project.name)")
                                        .help("Project Actions")
                                    }
                                    .disabled(library.isSaving)
                            }
                        }
                    }
                }
                .padding(20)
            }
            .accessibilityIdentifier("project-grid")
        }
    }

    private var header: some View {
        VStack(alignment: .leading, spacing: 20) {
            TimelineView(.periodic(from: .now, by: 60)) { context in
                HStack(alignment: .firstTextBaseline) {
                    VStack(alignment: .leading, spacing: 5) {
                        Text(greeting(at: context.date)).font(.title3.weight(.semibold))
                        Text(context.date, format: .dateTime.weekday(.wide).month().day())
                            .font(.subheadline).foregroundStyle(.secondary)
                    }
                    Spacer(minLength: 12)
                    Text("\(visibleProjects.count) projects")
                        .font(.subheadline).foregroundStyle(.secondary)
                }
            }
            if sizeClass != .regular {
                Picker("Project Library", selection: $filter) {
                    ForEach(LibraryFilter.allCases) { item in
                        Text(item.shortTitle).tag(item)
                    }
                }
                .pickerStyle(.segmented)
                .accessibilityIdentifier("library-filter")
            }
        }
    }

    private var emptyState: some View {
        ContentUnavailableView {
            Label(query.isEmpty ? filter.emptyTitle : String(localized: "No Results"), systemImage: query.isEmpty ? filter.symbol : "magnifyingglass")
        } actions: {
            if !query.isEmpty {
                Button("Clear Search") { query = "" }
            } else if filter == .all {
                Button("New Project", systemImage: "plus") { editor = .create }
                    .buttonStyle(.borderedProminent)
                    .accessibilityIdentifier("empty-new-project")
            }
        }
        .frame(maxWidth: .infinity, minHeight: 300)
        .accessibilityIdentifier("library-empty-state")
    }

    @ViewBuilder private func projectActions(_ project: LocalProject) -> some View {
        if project.isDeleted {
            Button("Restore", systemImage: "arrow.uturn.backward") { perform { try await library.restore(project.id) } }
            Button("Delete Permanently", systemImage: "trash", role: .destructive) { confirmation = .delete(project) }
        } else {
            Button(project.isFavorite ? String(localized: "Unfavorite") : String(localized: "Favorite"), systemImage: project.isFavorite ? "star.slash" : "star") {
                perform { try await library.toggleFavorite(project.id) }
            }
            Button("Edit Project", systemImage: "pencil") { editor = .edit(project) }
            Button("Move to Trash", systemImage: "trash", role: .destructive) { confirmation = .trash(project) }
        }
    }

    private func projectCount(for filter: LibraryFilter) -> Int {
        switch filter {
        case .all: library.projects.filter { !$0.isDeleted }.count
        case .recent: min(5, library.projects.filter { !$0.isDeleted }.count)
        case .favorites: library.projects.filter { $0.isFavorite && !$0.isDeleted }.count
        case .trash: library.projects.filter(\.isDeleted).count
        }
    }

    private func greeting(at date: Date) -> String {
        switch Calendar.current.component(.hour, from: date) {
        case 5..<12: String(localized: "Good Morning")
        case 12..<18: String(localized: "Good Afternoon")
        default: String(localized: "Good Evening")
        }
    }

    private func perform(_ action: @escaping @MainActor () async throws -> Void) {
        Task {
            do { try await action() }
            catch { actionError = error.localizedDescription }
        }
    }
}

#Preview {
    ProjectHomeView().environment(ProjectLibrary())
}
