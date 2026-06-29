import { useCallback, useRef, useState } from "react";
import { toast } from "sonner";
import { FileDown, Loader2, MapPin, Sheet, Trash2 } from "lucide-react";
import { Modal } from "@/client/components/Modal";
import {
  AppDataTable,
  useAppTable,
} from "@/client/components/table/AppDataTable";
import {
  TableBulkActionBar,
  TableBulkActionButton,
  TableBulkExportMenu,
} from "@/client/components/table/TableBulkActionBar";
import { buildCsv } from "@/client/lib/csv";
import { downloadCsv } from "@/client/lib/csv";
import { exportTableToSheets } from "@/client/lib/exportToSheets";
import { captureClientEvent } from "@/client/lib/posthog";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import {
  removeTrackingKeywords,
  updateKeywordLocation,
} from "@/serverFunctions/rank-tracking";
import { getStandardErrorMessage } from "@/client/lib/error-messages";
import type { RankTrackingRow } from "@/types/schemas/rank-tracking";
import { useRankTrackingColumns } from "./RankTrackingColumns";
import { buildRankTrackingExport } from "./RankTrackingTableParts";
import {
  KeywordTrendModal,
  type KeywordTrendTarget,
} from "./KeywordTrendModal";
import {
  LocationPicker,
  type LocationPickerValue,
} from "@/client/components/LocationPicker";
import { LOCATION_OPTIONS } from "@/shared/keyword-locations";
import type { SelectionAnchor } from "@/client/components/table/tableSelection";

export function RankTrackingTable({
  totalCount,
  rows,
  resultsLoading,
  showDesktop,
  showMobile,
  defaultSortId,
  domain,
  configId,
  projectId,
  locationCode,
  serpDepth,
}: {
  totalCount: number;
  rows: RankTrackingRow[];
  resultsLoading: boolean;
  showDesktop: boolean;
  showMobile: boolean;
  defaultSortId: string;
  domain: string;
  configId: string;
  projectId: string;
  locationCode: number;
  serpDepth: number;
}) {
  const queryClient = useQueryClient();
  const [showConfirm, setShowConfirm] = useState(false);
  const [trendTarget, setTrendTarget] = useState<KeywordTrendTarget | null>(
    null,
  );
  const [locationTarget, setLocationTarget] = useState<RankTrackingRow | null>(
    null,
  );
  const [showBulkLocationPicker, setShowBulkLocationPicker] = useState(false);
  const selectAnchorRef = useRef<SelectionAnchor | null>(null);

  const configLocationLabel =
    LOCATION_OPTIONS.find((o) => o.code === locationCode)?.label ??
    `Code ${locationCode}`;

  const handleKeywordClick = useCallback(
    (row: RankTrackingRow) =>
      setTrendTarget({
        trackingKeywordId: row.trackingKeywordId,
        keyword: row.keyword,
      }),
    [],
  );

  const handleLocationClick = useCallback(
    (row: RankTrackingRow) => setLocationTarget(row),
    [],
  );

  const locationMutation = useMutation({
    mutationFn: (args: {
      keywordId: string;
      locationCode: number | null;
      locationName: string | null;
    }) =>
      updateKeywordLocation({
        data: {
          projectId,
          configId,
          keywordId: args.keywordId,
          locationCode: args.locationCode,
          locationName: args.locationName,
        },
      }),
    onSuccess: () => {
      void queryClient.invalidateQueries({
        queryKey: ["rankTrackingResults", projectId, configId],
      });
    },
    onError: (error) => {
      toast.error(
        getStandardErrorMessage(error, "Failed to update keyword location"),
      );
    },
  });

  const bulkLocationMutation = useMutation({
    mutationFn: async (location: LocationPickerValue) => {
      const ids = selectedRows.map((r) => r.id);
      await Promise.all(
        ids.map((keywordId) =>
          updateKeywordLocation({
            data: {
              projectId,
              configId,
              keywordId,
              locationCode: location.code,
              locationName: location.name,
            },
          }),
        ),
      );
      return { count: ids.length };
    },
    onSuccess: ({ count }) => {
      setShowBulkLocationPicker(false);
      table.resetRowSelection();
      void queryClient.invalidateQueries({
        queryKey: ["rankTrackingResults", projectId, configId],
      });
      toast.success(
        `Location updated for ${count} keyword${count !== 1 ? "s" : ""}`,
      );
    },
    onError: (error) => {
      toast.error(
        getStandardErrorMessage(error, "Failed to update locations"),
      );
    },
  });

  const columns = useRankTrackingColumns(
    showDesktop,
    showMobile,
    domain,
    selectAnchorRef,
    handleKeywordClick,
    configLocationLabel,
    handleLocationClick,
  );

  const table = useAppTable({
    data: rows,
    columns,
    initialState: {
      sorting: [{ id: defaultSortId, desc: false }],
    },
    withSorting: true,
    getRowId: (row) => row.trackingKeywordId,
    enableRowSelection: true,
  });

  // Only includes rows that are in the current data (respects parent filtering)
  const selectedRows = table.getSelectedRowModel().rows;
  const selectedCount = selectedRows.length;
  const selectedRankRows = selectedRows.map((row) => row.original);

  const exportSelectionToSheets = () => {
    const { headers, rows: exportRows } = buildRankTrackingExport(
      selectedRankRows,
      showDesktop,
      showMobile,
    );
    void exportTableToSheets({
      headers,
      rows: exportRows,
      feature: "rank_tracking",
    });
  };

  const exportSelectionCsv = () => {
    const { headers, rows: exportRows } = buildRankTrackingExport(
      selectedRankRows,
      showDesktop,
      showMobile,
    );
    const csvRows = exportRows.map((row) =>
      row.map((cell, idx) =>
        idx === 3 && typeof cell === "number" ? cell.toFixed(2) : cell,
      ),
    );
    downloadCsv(
      `rank-tracking-${domain}-selected.csv`,
      buildCsv(headers, csvRows),
    );
    captureClientEvent("rank_tracking:export_csv", { scope: "selection" });
  };

  const removeMutation = useMutation({
    mutationFn: (keywordIds: string[]) =>
      removeTrackingKeywords({ data: { projectId, configId, keywordIds } }),
    onSuccess: (result) => {
      table.resetRowSelection();
      setShowConfirm(false);
      void queryClient.invalidateQueries({
        queryKey: ["rankTrackingResults", projectId, configId],
      });
      void queryClient.invalidateQueries({
        queryKey: ["rankTrackingCostEstimate", projectId, configId],
      });
      toast.success(
        `${result.removed} keyword${result.removed !== 1 ? "s" : ""} removed`,
      );
    },
    onError: (error) => {
      toast.error(getStandardErrorMessage(error, "Failed to remove keywords"));
    },
  });

  if (resultsLoading) {
    return (
      <div className="flex items-center justify-center p-8">
        <Loader2 className="size-5 animate-spin text-base-content/50" />
      </div>
    );
  }

  if (rows.length === 0) {
    return (
      <div className="rounded-xl border border-dashed border-base-300 p-10 text-center text-sm text-base-content/55">
        {totalCount === 0
          ? 'No rank data yet. Click "Check Now" to run your first check.'
          : "No keywords match your search."}
      </div>
    );
  }

  return (
    <>
      <TableBulkActionBar
        selectedCount={selectedCount}
        onClear={() => table.resetRowSelection()}
        actions={
          <div className="flex items-center px-1.5">
            <TableBulkActionButton
              icon={<MapPin className="size-3.5" />}
              onClick={() => setShowBulkLocationPicker(true)}
            >
              Set location
            </TableBulkActionButton>
            <TableBulkActionButton
              icon={<Trash2 className="size-3.5" />}
              onClick={() => setShowConfirm(true)}
              variant="danger"
            >
              Remove
            </TableBulkActionButton>
            <TableBulkExportMenu
              actions={[
                {
                  label: "Export to Sheets",
                  icon: <Sheet className="size-4" />,
                  onClick: exportSelectionToSheets,
                },
                {
                  label: "Export CSV",
                  icon: <FileDown className="size-4" />,
                  onClick: exportSelectionCsv,
                },
              ]}
            />
          </div>
        }
      />

      {/* Confirm modal */}
      {showConfirm && (
        <Modal
          onClose={() => setShowConfirm(false)}
          labelledBy="remove-keywords-title"
        >
          <h3 id="remove-keywords-title" className="text-lg font-semibold">
            Remove keywords?
          </h3>
          <p className="text-sm text-base-content/70">
            This will stop tracking {selectedCount} keyword
            {selectedCount !== 1 ? "s" : ""}. Historical ranking data is
            preserved but won't appear in the table.
          </p>
          <div className="flex justify-end gap-2">
            <button
              className="btn btn-ghost btn-sm"
              onClick={() => setShowConfirm(false)}
            >
              Cancel
            </button>
            <button
              className="btn btn-error btn-sm gap-1"
              onClick={() =>
                removeMutation.mutate(selectedRows.map((r) => r.id))
              }
              disabled={removeMutation.isPending}
            >
              {removeMutation.isPending && (
                <Loader2 className="size-3 animate-spin" />
              )}
              Remove {selectedCount} keyword
              {selectedCount !== 1 ? "s" : ""}
            </button>
          </div>
        </Modal>
      )}

      {trendTarget && (
        <KeywordTrendModal
          target={trendTarget}
          projectId={projectId}
          configId={configId}
          domain={domain}
          locationCode={locationCode}
          serpDepth={serpDepth}
          onClose={() => setTrendTarget(null)}
        />
      )}

      {/* Single-keyword location picker modal */}
      {locationTarget && (
        <Modal
          onClose={() => setLocationTarget(null)}
          labelledBy="set-keyword-location-title"
        >
          <h3 id="set-keyword-location-title" className="text-lg font-semibold">
            Set location for "{locationTarget.keyword}"
          </h3>
          <p className="text-sm text-base-content/70 mb-3">
            Override the config default ({configLocationLabel}) for this keyword.
          </p>
          <LocationPicker
            value={
              locationTarget.locationCode != null
                ? {
                    code: locationTarget.locationCode,
                    name:
                      locationTarget.locationName ??
                      `Code ${locationTarget.locationCode}`,
                  }
                : null
            }
            onChange={(loc) => {
              locationMutation.mutate(
                {
                  keywordId: locationTarget.trackingKeywordId,
                  locationCode: loc.code,
                  locationName: loc.name,
                },
                {
                  onSuccess: () => {
                    setLocationTarget(null);
                    toast.success(`Location set to ${loc.name}`);
                  },
                },
              );
            }}
            placeholder="Search locations…"
          />
          <div className="flex justify-end gap-2 mt-4">
            {locationTarget.locationCode != null && (
              <button
                className="btn btn-ghost btn-sm"
                onClick={() => {
                  locationMutation.mutate(
                    {
                      keywordId: locationTarget.trackingKeywordId,
                      locationCode: null,
                      locationName: null,
                    },
                    {
                      onSuccess: () => {
                        setLocationTarget(null);
                        toast.success("Location reset to config default");
                      },
                    },
                  );
                }}
                disabled={locationMutation.isPending}
              >
                Reset to default
              </button>
            )}
            <button
              className="btn btn-ghost btn-sm"
              onClick={() => setLocationTarget(null)}
            >
              Cancel
            </button>
          </div>
        </Modal>
      )}

      {/* Bulk location picker modal */}
      {showBulkLocationPicker && (
        <Modal
          onClose={() => setShowBulkLocationPicker(false)}
          labelledBy="bulk-location-title"
        >
          <h3 id="bulk-location-title" className="text-lg font-semibold">
            Set location for {selectedCount} keyword
            {selectedCount !== 1 ? "s" : ""}
          </h3>
          <p className="text-sm text-base-content/70 mb-3">
            All selected keywords will use this location for rank checks.
          </p>
          <LocationPicker
            value={null}
            onChange={(loc) => bulkLocationMutation.mutate(loc)}
            placeholder="Search locations…"
          />
          {bulkLocationMutation.isPending && (
            <div className="flex items-center gap-2 mt-3 text-sm text-base-content/60">
              <Loader2 className="size-3.5 animate-spin" />
              Updating {selectedCount} keyword
              {selectedCount !== 1 ? "s" : ""}…
            </div>
          )}
          <div className="flex justify-end gap-2 mt-4">
            <button
              className="btn btn-ghost btn-sm"
              onClick={() => setShowBulkLocationPicker(false)}
              disabled={bulkLocationMutation.isPending}
            >
              Cancel
            </button>
          </div>
        </Modal>
      )}

      <AppDataTable table={table} getCellClassName={() => "align-top"} />
      <p className="text-xs text-base-content/60 pt-2">
        {rows.length} of {totalCount} keywords
      </p>
    </>
  );
}
