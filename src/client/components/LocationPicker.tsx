import { useEffect, useRef, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { Globe, MapPin, Map, Search } from "lucide-react";
import { searchLocations } from "@/serverFunctions/locations";

export interface LocationPickerValue {
  code: number;
  name: string;
  fullName: string;
}

interface LocationPickerProps {
  value: { code: number; name: string } | null;
  onChange: (location: LocationPickerValue) => void;
  placeholder?: string;
  className?: string;
}

function LocationTypeIcon({ type }: { type: string }) {
  switch (type.toLowerCase()) {
    case "country":
      return <Globe className="size-3.5 shrink-0 text-base-content/40" />;
    case "region":
    case "state":
    case "province":
      return <Map className="size-3.5 shrink-0 text-base-content/40" />;
    default:
      return <MapPin className="size-3.5 shrink-0 text-base-content/40" />;
  }
}

function useDebounce(value: string, delay: number): string {
  const [debounced, setDebounced] = useState(value);
  useEffect(() => {
    const timer = setTimeout(() => setDebounced(value), delay);
    return () => clearTimeout(timer);
  }, [value, delay]);
  return debounced;
}

/**
 * Searchable location picker for DataForSEO locations (countries, provinces, cities).
 * Debounces input and queries the server, showing a results dropdown below.
 */
export function LocationPicker({
  value,
  onChange,
  placeholder = "Search locations…",
  className = "w-full",
}: LocationPickerProps) {
  const [open, setOpen] = useState(false);
  const [inputText, setInputText] = useState("");
  const [focused, setFocused] = useState(false);

  const containerRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLInputElement>(null);
  const listRef = useRef<HTMLUListElement>(null);
  const [activeIndex, setActiveIndex] = useState(0);

  const debouncedQuery = useDebounce(inputText, 300);

  const searchQuery = useQuery({
    queryKey: ["locations-search", debouncedQuery],
    queryFn: () => searchLocations({ data: { query: debouncedQuery } }),
    enabled: debouncedQuery.trim().length >= 2,
    staleTime: 1000 * 60 * 5, // 5 minutes — location data is stable
  });

  const results = searchQuery.data ?? [];

  // Close on outside click
  useEffect(() => {
    if (!open) return;
    const handlePointerDown = (event: PointerEvent) => {
      const target = event.target;
      if (target instanceof Node && !containerRef.current?.contains(target)) {
        setOpen(false);
        setFocused(false);
      }
    };
    document.addEventListener("pointerdown", handlePointerDown);
    return () => document.removeEventListener("pointerdown", handlePointerDown);
  }, [open]);

  // Keep highlighted item in view
  useEffect(() => {
    if (!open || results.length === 0) return;
    const activeItem = listRef.current?.children[activeIndex];
    activeItem?.scrollIntoView({ block: "nearest" });
  }, [activeIndex, open, results.length]);

  // Open dropdown when results arrive (query became valid)
  useEffect(() => {
    if (focused && debouncedQuery.trim().length >= 2) {
      setOpen(true);
      setActiveIndex(0);
    }
  }, [debouncedQuery, focused, results]);

  const select = (location: (typeof results)[number]) => {
    onChange({ code: location.code, name: location.name, fullName: location.fullName });
    setInputText("");
    setOpen(false);
    setFocused(false);
    inputRef.current?.blur();
  };

  const handleFocus = () => {
    setFocused(true);
    // Clear so the user can start typing immediately
    setInputText("");
    if (debouncedQuery.trim().length >= 2) {
      setOpen(true);
    }
  };

  const handleBlur = () => {
    // Blur fires before the dropdown click registers — defer to let click land
    setTimeout(() => {
      if (!containerRef.current?.contains(document.activeElement)) {
        setFocused(false);
        setOpen(false);
        setInputText("");
      }
    }, 150);
  };

  const handleKeyDown = (event: React.KeyboardEvent) => {
    switch (event.key) {
      case "ArrowDown":
        event.preventDefault();
        setActiveIndex((i) => Math.min(i + 1, results.length - 1));
        break;
      case "ArrowUp":
        event.preventDefault();
        setActiveIndex((i) => Math.max(i - 1, 0));
        break;
      case "Enter": {
        event.preventDefault();
        const loc = results[activeIndex];
        if (loc) select(loc);
        break;
      }
      case "Escape":
        event.preventDefault();
        setOpen(false);
        setFocused(false);
        inputRef.current?.blur();
        break;
    }
  };

  // Display text: show current value label when not focused, otherwise show typed text
  const displayValue = focused ? inputText : (value?.name ?? "");

  const showDropdown = open && focused && debouncedQuery.trim().length >= 2;

  return (
    <div ref={containerRef} className={`relative ${className}`}>
      <label className="flex items-center gap-2 rounded-lg border border-base-300 bg-base-100 px-3 py-2 focus-within:border-primary focus-within:outline-none">
        <Search className="size-4 shrink-0 text-base-content/40" />
        <input
          ref={inputRef}
          type="text"
          className="grow min-w-0 bg-transparent text-sm outline-none placeholder:text-base-content/40"
          placeholder={value ? value.name : placeholder}
          value={displayValue}
          onChange={(e) => {
            setInputText(e.target.value);
            setActiveIndex(0);
          }}
          onFocus={handleFocus}
          onBlur={handleBlur}
          onKeyDown={handleKeyDown}
          autoComplete="off"
        />
        {searchQuery.isFetching ? (
          <span className="loading loading-spinner loading-xs shrink-0 text-base-content/30" />
        ) : null}
      </label>

      {showDropdown ? (
        <div className="absolute left-0 right-0 z-30 mt-1 rounded-box border border-base-300 bg-base-100 shadow-lg">
          <ul
            ref={listRef}
            role="listbox"
            className="menu max-h-64 w-full flex-nowrap overflow-y-auto p-2"
          >
            {results.length === 0 && !searchQuery.isFetching ? (
              <li className="px-3 py-2 text-sm text-base-content/50">
                No locations found for "{debouncedQuery.trim()}"
              </li>
            ) : (
              results.map((loc, index) => (
                <li key={loc.code} role="option" aria-selected={index === activeIndex}>
                  <button
                    type="button"
                    className={`w-full text-left ${index === activeIndex ? "menu-focus" : ""}`}
                    onMouseDown={(e) => e.preventDefault()} // prevent blur before click
                    onClick={() => select(loc)}
                    onMouseEnter={() => setActiveIndex(index)}
                  >
                    <LocationTypeIcon type={loc.type} />
                    <span className="flex min-w-0 flex-1 flex-col">
                      <span className="truncate text-sm">{loc.name}</span>
                      {loc.fullName !== loc.name ? (
                        <span className="truncate text-xs text-base-content/50">
                          {loc.fullName}
                        </span>
                      ) : null}
                    </span>
                    <span className="shrink-0 rounded-full bg-base-200 px-2 py-0.5 text-xs text-base-content/50 capitalize">
                      {loc.type.toLowerCase()}
                    </span>
                  </button>
                </li>
              ))
            )}
          </ul>
        </div>
      ) : null}
    </div>
  );
}
