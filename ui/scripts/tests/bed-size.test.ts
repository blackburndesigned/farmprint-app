import { parseBedSize } from "../../src/components/BedSizeFields";
import { check, done } from "./check";

check(
  JSON.stringify(parseBedSize("", "", "")) === JSON.stringify({ bed_x_mm: null, bed_y_mm: null, bed_z_mm: null }),
  "all-blank bed size is not set"
);
check(
  JSON.stringify(parseBedSize("256", "256", "")) === JSON.stringify({ bed_x_mm: 256, bed_y_mm: 256, bed_z_mm: null }),
  "width and depth can be set with height left blank"
);
check(
  JSON.stringify(parseBedSize("", "", "256")) === JSON.stringify({ bed_x_mm: null, bed_y_mm: null, bed_z_mm: 256 }),
  "height can be set without width and depth"
);
check(
  JSON.stringify(parseBedSize("256", "240", "256")) === JSON.stringify({ bed_x_mm: 256, bed_y_mm: 240, bed_z_mm: 256 }),
  "width, depth and height are kept"
);
check("error" in parseBedSize("256", "", ""), "width without depth is an error");
check("error" in parseBedSize("5", "256", ""), "width out of range is an error");
check("error" in parseBedSize("256", "256", "5"), "height out of range is an error");
check(
  JSON.stringify(parseBedSize(" 256 ", " 256 ", "  256 ")) === JSON.stringify({ bed_x_mm: 256, bed_y_mm: 256, bed_z_mm: 256 }),
  "bed size values are trimmed"
);

done();
