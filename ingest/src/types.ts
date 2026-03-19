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
