import SwiftUI

extension ProjectTint {
    var color: Color {
        switch self {
        case .rose: Color.accentColor
        case .blue: .blue
        case .green: .teal
        case .gold: .yellow
        case .coral: .orange
        case .graphite: .gray
        }
    }

    var title: String {
        switch self {
        case .rose: String(localized: "Rose")
        case .blue: String(localized: "Blue")
        case .green: String(localized: "Green")
        case .gold: String(localized: "Gold")
        case .coral: String(localized: "Coral")
        case .graphite: String(localized: "Graphite")
        }
    }
}

struct ProjectCover: View {
    let project: LocalProject

    var body: some View {
        ZStack {
            project.tint.color.opacity(0.12)
            Image(systemName: "book.closed")
                .font(.system(size: 42, weight: .light))
                .foregroundStyle(project.tint.color.opacity(0.65))
        }
        .aspectRatio(16 / 9, contentMode: .fit)
        .overlay(alignment: .bottomLeading) {
            Text("Draft")
                .font(.caption2.weight(.medium))
                .foregroundStyle(.secondary)
                .padding(10)
        }
        .overlay(alignment: .topLeading) {
            if project.isFavorite {
                Image(systemName: "star.fill")
                    .font(.caption.weight(.semibold))
                    .foregroundStyle(project.tint.color)
                    .padding(10)
                    .accessibilityLabel("Favorite")
            }
        }
        .accessibilityHidden(true)
    }
}

struct ProjectCard: View {
    let project: LocalProject

    var body: some View {
        VStack(alignment: .leading, spacing: 0) {
            ProjectCover(project: project)
            VStack(alignment: .leading, spacing: 6) {
                Text(project.name)
                    .font(.headline)
                    .foregroundStyle(.primary)
                    .lineLimit(2, reservesSpace: true)
                Text(project.synopsis.isEmpty ? String(localized: "No Synopsis") : project.synopsis)
                    .font(.subheadline)
                    .foregroundStyle(.secondary)
                    .lineLimit(2, reservesSpace: true)
                HStack(spacing: 4) {
                    Image(systemName: "clock")
                    Text(project.lastActivity, style: .relative)
                }
                .font(.caption)
                .foregroundStyle(.secondary)
                .lineLimit(1)
                .padding(.top, 8)
            }
            .padding(12)
            .frame(maxWidth: .infinity, alignment: .leading)
        }
        .background(Color(uiColor: .secondarySystemGroupedBackground))
        .clipShape(RoundedRectangle(cornerRadius: 8))
        .overlay {
            RoundedRectangle(cornerRadius: 8)
                .strokeBorder(Color(uiColor: .separator).opacity(0.18), lineWidth: 1)
        }
        .contentShape(Rectangle())
    }
}

struct ProjectListRow: View {
    let project: LocalProject

    var body: some View {
        HStack(spacing: 14) {
            Image(systemName: "book.closed")
                .font(.title2.weight(.light))
                .foregroundStyle(project.tint.color)
                .frame(width: 52, height: 60)
                .background(project.tint.color.opacity(0.12), in: RoundedRectangle(cornerRadius: 6))
            VStack(alignment: .leading, spacing: 5) {
                HStack {
                    Text(project.name).font(.headline).lineLimit(2)
                    if project.isFavorite {
                        Image(systemName: "star.fill").font(.caption).foregroundStyle(.yellow)
                    }
                }
                if !project.synopsis.isEmpty {
                    Text(project.synopsis).font(.subheadline).foregroundStyle(.secondary).lineLimit(1)
                }
                Text(project.lastActivity, style: .relative)
                    .font(.caption).foregroundStyle(.secondary).lineLimit(1)
            }
            Spacer(minLength: 0)
        }
        .padding(.vertical, 5)
        .accessibilityElement(children: .combine)
    }
}

struct ProjectEditorSheet: View {
    @Environment(ProjectLibrary.self) private var library
    @Environment(\.dismiss) private var dismiss
    @FocusState private var nameFocused: Bool
    let project: LocalProject?
    var onSaved: (UUID) -> Void = { _ in }
    @State private var name: String
    @State private var synopsis: String
    @State private var tint: ProjectTint
    @State private var favorite: Bool
    @State private var saveError: String?

    init(project: LocalProject? = nil, onSaved: @escaping (UUID) -> Void = { _ in }) {
        self.project = project
        self.onSaved = onSaved
        _name = State(initialValue: project?.name ?? "")
        _synopsis = State(initialValue: project?.synopsis ?? "")
        _tint = State(initialValue: project?.tint ?? .rose)
        _favorite = State(initialValue: project?.isFavorite ?? false)
    }

    var body: some View {
        NavigationStack {
            Form {
                Section("Project") {
                    TextField("Project Name", text: $name, axis: .vertical)
                        .lineLimit(1...3)
                        .focused($nameFocused)
                        .accessibilityIdentifier("project-name")
                    TextField("Synopsis", text: $synopsis, axis: .vertical)
                        .lineLimit(4...8)
                        .accessibilityIdentifier("project-synopsis")
                }
                Section("Cover Color") {
                    HStack {
                        ForEach(ProjectTint.allCases) { choice in
                            Button {
                                tint = choice
                            } label: {
                                Image(systemName: tint == choice ? "checkmark.circle.fill" : "circle.fill")
                                    .font(.system(size: 30))
                                    .foregroundStyle(choice.color)
                                    .frame(maxWidth: .infinity, minHeight: 44)
                            }
                            .buttonStyle(.plain)
                            .accessibilityLabel(choice.title)
                            .accessibilityAddTraits(tint == choice ? .isSelected : [])
                            .accessibilityIdentifier("cover-\(choice.rawValue)")
                            .help(choice.title)
                        }
                    }
                }
                Section {
                    Toggle("Favorite", isOn: $favorite)
                }
            }
            .disabled(library.isSaving)
            .navigationTitle(project == nil ? String(localized: "New Project") : String(localized: "Edit Project"))
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .cancellationAction) {
                    Button("Cancel") { dismiss() }.disabled(library.isSaving)
                }
                ToolbarItem(placement: .confirmationAction) {
                    Button(project == nil ? String(localized: "Create") : String(localized: "Save")) {
                        Task {
                            do {
                                let id = try await library.saveProject(
                                    id: project?.id, name: name, synopsis: synopsis, tint: tint, favorite: favorite
                                )
                                dismiss()
                                onSaved(id)
                            } catch { saveError = error.localizedDescription }
                        }
                    }
                    .fontWeight(.semibold)
                    .disabled(name.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty || library.isSaving)
                    .accessibilityIdentifier("save-project")
                }
            }
            .alert("Couldn't Save Project", isPresented: Binding(get: { saveError != nil }, set: { if !$0 { saveError = nil } })) {
                Button("OK", role: .cancel) { saveError = nil }
            } message: { Text(saveError ?? "") }
            .onAppear { nameFocused = project == nil }
            .interactiveDismissDisabled(library.isSaving)
        }
    }
}

struct ProjectDetailView: View {
    @Environment(ProjectLibrary.self) private var library
    let projectID: UUID
    @State private var editing = false

    var body: some View {
        if let project = library.project(projectID) {
            Form {
                Section {
                    LabeledContent("Status") { Text(project.isDeleted ? String(localized: "In Trash") : String(localized: "Draft")) }
                    if !project.synopsis.isEmpty { Text(project.synopsis).textSelection(.enabled) }
                }
                Section("Dates") {
                    LabeledContent("Created") { Text(project.createdAt, format: .dateTime.year().month().day()) }
                    LabeledContent("Modified") { Text(project.modifiedAt, format: .dateTime.year().month().day().hour().minute()) }
                }
            }
            .navigationTitle(project.name)
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                if !project.isDeleted {
                    ToolbarItem(placement: .primaryAction) {
                        Button("Edit Project", systemImage: "pencil") { editing = true }
                            .accessibilityIdentifier("edit-project")
                            .help("Edit Project")
                    }
                }
            }
            .sheet(isPresented: $editing) { ProjectEditorSheet(project: library.project(projectID)) }
            .task(id: projectID) {
                if !project.isDeleted { try? await library.markOpened(projectID) }
            }
        } else {
            ContentUnavailableView("Project Unavailable", systemImage: "folder.badge.questionmark")
        }
    }
}
