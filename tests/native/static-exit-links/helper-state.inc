  struct FPSCR { u32 VE = 0; bool operator==(const FPSCR&) const = default; } fpscr;
  struct PS {
    std::array<u64, 2> bits{std::bit_cast<u64>(0.125), std::bit_cast<u64>(0.125)};
    double PS0AsDouble() const { return std::bit_cast<double>(bits[0]); }
    u64 PS0AsU64() const { return bits[0]; }
    void SetPS0(double value) { bits[0] = std::bit_cast<u64>(value); }
    void SetPS0(u64 value) { bits[0] = value; }
    void Fill(double value) { bits.fill(std::bit_cast<u64>(value)); }
    bool operator==(const PS&) const = default;
  };
  std::array<PS, 32> ps;
