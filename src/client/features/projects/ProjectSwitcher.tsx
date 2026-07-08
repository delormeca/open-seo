import { useMemo, useState } from "react";
import { Link, useNavigate } from "@tanstack/react-router";
import { useQuery } from "@tanstack/react-query";
import { Check, ChevronsUpDown, FolderCog, Search } from "lucide-react";
import { getProjects } from "@/serverFunctions/projects";
import { setLastProjectId } from "@/client/lib/active-project";
import type { ProjectSummary } from "./types";

function closeDropdown() {
  if (document.activeElement instanceof HTMLElement) {
    document.activeElement.blur();
  }
}

export function ProjectSwitcher({
  activeProjectId,
  variant = "topbar",
  onCloseDrawer,
}: {
  activeProjectId: string | null;
  variant?: "topbar" | "sidebar";
  // Mobile sidebar passes this so switching / navigating away also closes the
  // drawer overlay.
  onCloseDrawer?: () => void;
}) {
  const navigate = useNavigate();
  const [search, setSearch] = useState("");
  const projectsQuery = useQuery({
    queryKey: ["projects"],
    queryFn: () => getProjects(),
  });
  const projects = projectsQuery.data ?? [];
  const activeProject =
    projects.find((project) => project.id === activeProjectId) ?? null;

  const isSidebar = variant === "sidebar";

  const filteredProjects = useMemo(() => {
    const q = search.trim().toLowerCase();
    if (!q) return projects;
    return projects.filter(
      (p) =>
        p.name.toLowerCase().includes(q) ||
        (p.domain && p.domain.toLowerCase().includes(q)),
    );
  }, [projects, search]);

  const handleSelect = (project: ProjectSummary) => {
    closeDropdown();
    setSearch("");
    onCloseDrawer?.();
    if (project.id === activeProjectId) return;
    setLastProjectId(project.id);
    void navigate({
      to: "/p/$projectId/keywords",
      params: { projectId: project.id },
    });
  };

  return (
    <div className={`dropdown ${isSidebar ? "w-full" : "dropdown-end"}`}>
      <button
        type="button"
        tabIndex={0}
        aria-label="Switch project"
        className={
          isSidebar
            ? "btn btn-ghost btn-sm w-full justify-between font-medium"
            : "flex h-10 max-w-[12rem] items-center gap-2 rounded-full px-3 text-left transition-colors hover:bg-base-200/80"
        }
      >
        <span className="flex min-w-0 flex-col">
          <span className="truncate text-sm font-medium text-base-content">
            {activeProject?.name ?? "Select project"}
          </span>
          {activeProject?.domain ? (
            <span className="truncate text-xs font-normal text-base-content/50">
              {activeProject.domain}
            </span>
          ) : null}
        </span>
        <ChevronsUpDown className="size-3.5 shrink-0 text-base-content/40" />
      </button>

      <div
        tabIndex={0}
        className={`dropdown-content z-30 flex flex-col rounded-box border border-base-300 bg-base-100 shadow-lg ${
          isSidebar ? "w-full" : "mt-2 w-64"
        }`}
      >
        <div className="px-2 pt-2 pb-1">
          <label className="input input-bordered input-sm flex items-center gap-2 bg-base-100">
            <Search className="size-3.5 text-base-content/40" />
            <input
              type="text"
              className="grow text-sm"
              placeholder="Search projects..."
              value={search}
              onChange={(e) => setSearch(e.target.value)}
              onKeyDown={(e) => e.stopPropagation()}
            />
          </label>
        </div>
        <ul className="menu p-2 pt-0 max-h-72 overflow-y-auto">
          {filteredProjects.map((project) => {
            const isActive = project.id === activeProjectId;
            return (
              <li key={project.id}>
                <button
                  type="button"
                  onClick={() => handleSelect(project)}
                  className={isActive ? "active" : ""}
                >
                  <span className="flex min-w-0 flex-1 flex-col">
                    <span className="truncate">{project.name}</span>
                    {project.domain ? (
                      <span className="truncate text-xs text-base-content/50">
                        {project.domain}
                      </span>
                    ) : null}
                  </span>
                  {isActive ? (
                    <Check className="size-4 shrink-0 text-primary" />
                  ) : null}
                </button>
              </li>
            );
          })}
          {filteredProjects.length === 0 && (
            <li className="px-3 py-2 text-xs text-base-content/50">
              No matching projects
            </li>
          )}
        </ul>
        <div className="border-t border-base-300 p-2">
          <ul className="menu p-0">
            <li>
              <Link
                to="/projects"
                onClick={() => {
                  closeDropdown();
                  setSearch("");
                  onCloseDrawer?.();
                }}
              >
                <FolderCog className="size-4" />
                Manage projects
              </Link>
            </li>
          </ul>
        </div>
      </div>
    </div>
  );
}
