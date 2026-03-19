export interface JlcpartsIndex {
  categories: Record<
    string,
    Record<
      string,
      {
        sourcename: string;
        datahash: string;
        stockhash: string;
      }
    >
  >;
  created: string;
}

export interface CategoryData {
  schema: string[];
  components: unknown[][];
  category?: string;
  subcategory?: string;
}

export type StockData = Record<string, number>;

export interface PartRow {
  lcsc: string;
  mpn: string;
  manufacturer: string | null;
  category: string;
  subcategory: string;
  description: string;
  datasheet: string | null;
  package: string | null;
  joints: number | null;
  moq: number | null;
  stock: number;
  jlc_stock: number;
  price_raw: string;
  img: string | null;
  url: string | null;
  part_type: string;
  pcba_type: string;
  attributes: string;
  search_text: string;
}

export interface IngestMeta {
  category: string;
  subcategory: string;
  sourcename: string;
  datahash: string;
  stockhash: string;
  ingested_at: number;
}

// Raw data storage types

export interface JlcpartsHashes {
  [sourcename: string]: { datahash: string; stockhash: string; downloadedAt: string };
}

export interface JlcpcbRunManifest {
  startedAt: string;
  completedAt?: string;
  queries: JlcpcbQueryEntry[];
}

export interface JlcpcbQueryEntry {
  key: string;
  slug: string;
  label: string;
  params: QueryParams;
  totalParts: number;
  pagesDownloaded: number;
  complete: boolean;
}

export interface QueryParams {
  firstSortName: string;
  secondSortName?: string;
  stockFlag?: number;
  componentLibraryType?: string;
}

export interface LcscEnrichmentRecord {
  lcsc: string;
  moq?: number;
  price_raw?: string;
  stock?: number;
}

// Datasheet types

export interface DatasheetUrlEntry {
  lcsc: string;
  url: string;
  category: string;
  subcategory: string;
}

export interface DatasheetManifest {
  startedAt: string;
  completedAt?: string;
  downloaded: number;
  failed: number;
  skipped: number;
  urlMap: Record<string, string>;       // url → first lcsc that downloaded it
  failures: Record<string, string>;     // lcsc → error reason
}

export interface DatasheetMeta {
  lcsc: string;
  extracted_at: number;
  page_count: number;
  char_count: number;
  props_found: number;
}

export interface ExtractedProperty {
  key: string;         // e.g. "capacitance", "voltage_max", "rds_on"
  value: number;
  unit: string;        // V, F, Ohm, etc. (matches part_nums units)
  source: string;      // "datasheet", "description", "attributes"
}

export interface ExtractionResult {
  properties: ExtractedProperty[];
  keywords: string[];  // search tokens not captured by numeric extraction
}
