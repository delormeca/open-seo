import { useState } from "react";
import { toast } from "sonner";
import { useMutation } from "@tanstack/react-query";
import { addTrackingKeywords } from "@/serverFunctions/rank-tracking";
import { getStandardErrorMessage } from "@/client/lib/error-messages";
import { Loader2 } from "lucide-react";
import {
  LocationPicker,
  type LocationPickerValue,
} from "@/client/components/LocationPicker";
import { LOCATION_OPTIONS } from "@/shared/keyword-locations";

export function AddKeywordsPanel({
  configId,
  projectId,
  configLocationCode,
  onSuccess,
  onCancel,
}: {
  configId: string;
  projectId: string;
  configLocationCode: number;
  onSuccess: (result: { added: number; checkTriggered: boolean }) => void;
  onCancel: () => void;
}) {
  const [keywordInput, setKeywordInput] = useState("");
  const configOption = LOCATION_OPTIONS.find(
    (o) => o.code === configLocationCode,
  );
  const [selectedLocation, setSelectedLocation] =
    useState<LocationPickerValue | null>(
      configOption
        ? { code: configOption.code, name: configOption.label, fullName: configOption.label }
        : null,
    );
  const mutation = useMutation({
    mutationFn: (kws: string[]) =>
      addTrackingKeywords({
        data: {
          projectId,
          configId,
          keywords: kws,
          locationCode: selectedLocation?.code,
          locationName: selectedLocation?.name,
        },
      }),
    onSuccess: (result) => {
      setKeywordInput("");
      onSuccess(result);
    },
    onError: (error) => {
      toast.error(getStandardErrorMessage(error, "Failed to add keywords"));
    },
  });
  const isPending = mutation.isPending;
  return (
    <div className="flex flex-col gap-3">
      <div className="flex gap-2 items-end">
        <textarea
          className="textarea textarea-bordered textarea-sm flex-1"
          rows={3}
          placeholder="Enter keywords, one per line"
          value={keywordInput}
          onChange={(e) => setKeywordInput(e.target.value)}
        />
        <div className="flex flex-col gap-1">
          <button
            className="btn btn-primary btn-sm"
            onClick={() => {
              const lines = keywordInput
                .split("\n")
                .map((l) => l.trim())
                .filter(Boolean);
              if (lines.length > 0) mutation.mutate(lines);
            }}
            disabled={isPending || !keywordInput.trim()}
          >
            {isPending && <Loader2 className="size-3 animate-spin" />}
            Add
          </button>
          <button className="btn btn-ghost btn-sm" onClick={onCancel}>
            Cancel
          </button>
        </div>
      </div>
      <div className="max-w-xs">
        <label className="label py-0">
          <span className="label-text text-xs text-base-content/60">
            Default location for these keywords
          </span>
        </label>
        <LocationPicker
          value={selectedLocation ? { code: selectedLocation.code, name: selectedLocation.name } : null}
          onChange={setSelectedLocation}
          placeholder="Search locations…"
        />
      </div>
    </div>
  );
}
