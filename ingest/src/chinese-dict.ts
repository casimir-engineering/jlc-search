/**
 * Chinese → English dictionary for JLCPCB part fields (package, mpn).
 *
 * Terms are ordered longest-first so greedy matching works correctly.
 * Similar concepts are mapped to a single canonical English term.
 *
 * Rebuild after editing: bun run ingest/src/translate-parts.ts
 */

// Entries: [Chinese, English]
// Longest compounds first, then shorter terms.
const DICT: [string, string][] = [
  // ── Mounting: compound terms first ──
  ["螺栓安装", "Bolt-Mount"],
  ["弯简牛", "Right-Angle Box Header"],
  ["直简牛", "Straight Box Header"],
  ["弯牛角", "Right-Angle Shrouded Header"],
  ["直牛角", "Straight Shrouded Header"],
  ["立贴简牛", "Vertical SMD Box Header"],
  ["卧贴编带", "Horizontal SMD Tape"],
  ["卧贴带柱", "Horizontal SMD w/Post"],
  ["卧贴盘", "Horizontal SMD Reel"],
  ["立贴带锁", "Vertical SMD Locking"],
  ["立贴双面接", "Vertical SMD Dual-Contact"],
  ["立贴针带柱", "Vertical SMD Pin w/Post"],
  ["立贴针", "Vertical SMD Pin"],
  ["立贴母", "Vertical SMD Female"],
  ["弯插", "Right-Angle Through-Hole"],
  ["直插排母", "Through-Hole Female Header"],
  ["直插", "Through-Hole"],
  ["卧贴", "Horizontal SMD"],
  ["立贴", "Vertical SMD"],
  ["贴片", "SMD"],
  ["插件", "Through-Hole"],
  ["贴板", "Board-Mount"],
  ["插板", "Through-Board"],
  ["沉板", "Recessed"],

  // ── Connectors ──
  ["牛角连接器", "Shrouded Header"],
  ["针座连接器", "Pin Header Socket"],
  ["孔型连接器", "Socket Connector"],
  ["连接器", "Connector"],
  ["短路帽开口", "Jumper Cap Open"],
  ["短路帽闭口", "Jumper Cap Closed"],
  ["短路帽", "Jumper Cap"],
  ["简牛加长针", "Box Header Extended Pin"],
  ["简牛直", "Box Header Straight"],
  ["简牛", "Box Header"],
  ["牛角弯", "Shrouded Header Right-Angle"],
  ["牛角", "Shrouded Header"],
  ["杜邦", "DuPont"],
  ["翻盖", "Clamshell"],
  ["排母", "Female Header"],
  ["排针", "Pin Header"],
  ["双排针", "Dual-Row Pin Header"],
  ["直排针", "Straight Pin Header"],
  ["反弯排针", "Reverse Right-Angle Pin Header"],
  ["三排针", "Triple-Row Pin Header"],
  ["双排接口", "Dual-Row Interface"],

  // ── Pin/orientation ──
  ["交错脚", "Staggered Pins"],
  ["交错角", "Staggered Angle"],
  ["反弯针", "Reverse Right-Angle Pin"],
  ["正弯针", "Forward Right-Angle Pin"],
  ["弯针", "Right-Angle Pin"],
  ["直针", "Straight Pin"],
  ["高弯空第", "Tall Right-Angle Skip"],
  ["高弯", "Tall Right-Angle"],
  ["反高弯", "Reverse Tall Right-Angle"],
  ["平弯", "Flat Right-Angle"],
  ["实心针", "Solid Pin"],
  ["空心针蓝色", "Hollow Pin Blue"],
  ["空心针红色", "Hollow Pin Red"],
  ["空心针", "Hollow Pin"],
  ["弯脚", "Bent Leg"],
  ["直脚", "Straight Leg"],
  ["弯形", "Right-Angle"],
  ["弯圆母", "Right-Angle Round Female"],
  ["弯母", "Right-Angle Female"],
  ["直母", "Straight Female"],
  ["弯", "Right-Angle"],
  ["直", "Straight"],
  ["同向", "Same Direction"],
  ["反向", "Reverse"],
  ["针空第", "Pin Skip"],
  ["针空", "Pin Skip"],
  ["针红色", "Pin Red"],
  ["针立贴", "Pin Vertical SMD"],
  ["针", "Pin"],
  ["上接", "Top Contact"],
  ["下接盘装", "Bottom Contact Reel"],
  ["下接翻盖", "Bottom Contact Clamshell"],
  ["下接", "Bottom Contact"],
  ["脚", "Leg"],
  ["方脚", "Square Leg"],

  // ── Gender / housing ──
  ["子弹头母端", "Bullet Female Terminal"],
  ["公头蓝色带固定螺柱双排", "Male Blue w/Screw Stud Dual-Row"],
  ["圆针公蓝色", "Round Pin Male Blue"],
  ["母加长针", "Female Extended Pin"],
  ["母环保", "Female RoHS"],
  ["母头", "Female"],
  ["母端", "Female Terminal"],
  ["母壳", "Female Housing"],
  ["公壳", "Male Housing"],
  ["公端", "Male Terminal"],
  ["圆母", "Round Female"],
  ["母高", "Female Tall"],
  ["母长", "Female Long"],
  ["母", "Female"],
  ["圆针", "Round Pin"],

  // ── Hardware / misc ──
  ["塑料防水电缆接头", "Plastic Waterproof Cable Gland"],
  ["焊板不带螺丝", "Solder-Board No Screw"],
  ["双排不带螺丝", "Dual-Row No Screw"],
  ["直排母袋装环保", "Straight Female Header Bag RoHS"],
  ["压线端子", "Crimp Terminal"],
  ["压线头", "Crimp Terminal"],
  ["隔离柱", "Standoff"],
  ["铜柱", "Copper Standoff"],
  ["螺栓", "Bolt"],
  ["螺母", "Screw Nut"],
  ["连接线", "Cable"],
  ["引线套管", "Lead Sleeve"],
  ["弹线环保", "Spring Wire RoHS"],
  ["弹线曲", "Spring Wire Curved"],
  ["弹线", "Spring Wire"],
  ["排线", "Ribbon Cable"],

  // ── Colors ──
  ["红绿双色", "Red-Green Bicolor"],
  ["白灰色", "Off-White"],
  ["米色", "Beige"],
  ["黑色", "Black"],
  ["绿色", "Green"],
  ["红色", "Red"],
  ["蓝色", "Blue"],
  ["黄色", "Yellow"],
  ["白色", "White"],
  ["灰色", "Gray"],
  ["全黑", "All Black"],
  ["本色", "Natural"],
  ["橙红", "Orange-Red"],
  ["纯红", "Pure Red"],
  ["红灯", "Red LED"],
  ["红", "Red"],
  ["黑", "Black"],

  // ── Properties / packaging ──
  ["玻璃管保险丝", "Glass Tube Fuse"],
  ["陶瓷保险丝", "Ceramic Fuse"],
  ["保险管夹", "Fuse Clip"],
  ["保险丝夹座", "Fuse Clip Holder"],
  ["保险丝支架", "Fuse Bracket"],
  ["保险丝透明座", "Fuse Clear Holder"],
  ["间距", "Pitch"],
  ["长", "Long"],
  ["环保", "RoHS"],
  ["编带包装", "Tape Packaging"],
  ["编带", "Tape"],
  ["散装", "Bulk"],
  ["袋装", "Bagged"],
  ["盘装", "Reel"],
  ["座", "Socket"],
  ["窄", "Narrow"],
  ["短耳", "Short Tab"],
  ["矮耳朵", "Low Tab"],
  ["微", "Micro"],
  ["环", "Ring"],
  ["同面", "Same Side"],
  ["件套", "Kit"],
  ["有边", "With Edge"],
  ["防错", "Keyed"],
  ["带扣", "With Latch"],
  ["带壳", "With Housing"],
  ["双塑", "Dual Plastic"],
  ["白胶", "White Adhesive"],
  ["黑胶", "Black Adhesive"],
  ["有头", "With Head"],
  ["无孔", "No Hole"],
  ["有孔", "With Hole"],
  ["单面接", "Single-Side Contact"],
  ["型", "Type"],
  ["款", "Style"],
  ["远", "Extended Range"],
  ["中型", "Medium"],
  ["小型", "Small"],
  ["单层", "Single Layer"],
  ["镀银环保", "Silver-Plated RoHS"],
  ["镀金", "Gold-Plated"],
  ["铜", "Copper"],
  ["铁", "Iron"],
  ["端子", "Terminal"],
  ["簧", "Spring"],
  ["平", "Flat"],
  ["外铜套", "Outer Copper Sleeve"],
  ["框架", "Frame"],
  ["柄", "Handle"],
  ["档", "Position"],
  ["位", "Digit"],
  ["寸", "Inch"],

  // ── Components ──
  ["耳机座直插", "Headphone Jack Through-Hole"],
  ["轻触按键", "Tact Switch"],
  ["拨码开关", "DIP Switch"],
  ["人体红外感应模块", "PIR Module"],
  ["无线接收模块", "Wireless Receiver Module"],
  ["运放等芯片", "Op-Amp IC"],
  ["导热矽胶片", "Thermal Pad"],
  ["点阵", "Dot Matrix"],
  ["共阴", "Common Cathode"],
  ["色温", "Color Temperature"],
  ["灯柱", "LED Standoff"],
  ["上脚漆", "Lacquered Leg"],
  ["色粉", "Phosphor"],
  ["新模", "New Mold"],
  ["新", "New"],
  ["丝印", "Silkscreen"],
  ["作废", "Deprecated"],
  ["临时启用", "Temporarily Enabled"],
  ["业务专用", "Business Use"],
  ["大的空料盘", "Empty Reel Large"],

  // ── Wire-to-board specifics ──
  ["前两脚有卷边有缺口铁壳", "Front 2-Pin Crimped Notched Iron Shell"],
  ["前两鱼叉脚无卷边铜壳", "Front 2-Fork No-Crimp Copper Shell"],
  ["度沉板弯脚有卷边铁壳", "Recessed Bent Crimped Iron Shell"],
  ["度沉板短弯脚无卷边铁壳", "Recessed Short-Bent No-Crimp Iron Shell"],
  ["铁壳有卷边高", "Iron Shell Crimped Tall"],
  ["型无柱直口", "Type No-Post Straight"],
  ["本色短端子", "Natural Short Terminal"],
  ["不耐高温", "Not Heat Resistant"],
  ["侧插铜", "Side-Insert Copper"],
  ["型母头", "Type Female"],
  ["度直脚", "Degree Straight Leg"],
  ["度", "Degree"],
  ["内弹", "Inner Spring"],

  // ── Battery ──
  ["二节五号背叠", "2xAA Back-to-Back"],
  ["弯脚电池片铜", "Bent Battery Tab Copper"],
  ["电池铜线扣", "Battery Copper Wire Clip"],
  ["线扣", "Wire Clip"],

  // ── Serial/USB ──
  ["针直针串口公头", "Pin Straight Serial Male"],
  ["苹果", "Apple"],

  // ── Misc packaging/product terms ──
  ["寸卷盘编带封装", "Inch Reel Tape Package"],
  ["型散热板黑色", "Heatsink Black"],
  ["型散热板", "Heatsink"],
  ["配", "Set"],
  ["个天线", "Antenna"],
  ["灵", "Smart"],
  ["有源", "Active"],
];

// Pre-sort by length descending for greedy matching
DICT.sort((a, b) => b[0].length - a[0].length);

/**
 * Replace Chinese terms in a string with their English equivalents.
 * Greedy: longest matches are replaced first.
 */
export function translateChinese(text: string): string {
  if (!text) return text;
  // Quick check: any Chinese characters at all?
  if (!/[\u4e00-\u9fff]/.test(text)) return text;

  let result = text;
  for (const [zh, en] of DICT) {
    if (result.includes(zh)) {
      // Add spaces at word boundaries: between latin/digit and the replacement
      result = result.replaceAll(zh, `\x00${en}\x00`);
    }
  }
  // Insert spaces at boundaries between markers and adjacent alphanumeric chars
  result = result.replace(/([A-Za-z0-9])\x00/g, "$1 ");
  result = result.replace(/\x00([A-Za-z0-9])/g, " $1");
  result = result.replace(/\x00/g, "");

  // Clean up: collapse multiple spaces, trim spaces around commas
  result = result.replace(/\s{2,}/g, " ").replace(/\s*,\s*/g, ",").trim();
  return result;
}
