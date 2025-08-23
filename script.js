// Neural Network Canvas Animation (Optimized)
class NeuralNetwork {
    constructor(canvas) {
        this.canvas = canvas;
        this.ctx = canvas.getContext('2d');
        this.nodes = [];
        this.connections = [];
        this.mouse = { x: 0, y: 0 };
        
        this.resize();
        this.init();
        this.animate();
        
        window.addEventListener('resize', () => this.resize());
        document.addEventListener('mousemove', (e) => {
            this.mouse.x = e.clientX;
            this.mouse.y = e.clientY;
        });
    }
    
    resize() {
        this.canvas.width = window.innerWidth;
        this.canvas.height = window.innerHeight;
    }
    
    init() {
        const nodeCount = Math.min(Math.floor((this.canvas.width * this.canvas.height) / 20000), 80);
        
        for (let i = 0; i < nodeCount; i++) {
            this.nodes.push({
                x: Math.random() * this.canvas.width,
                y: Math.random() * this.canvas.height,
                vx: (Math.random() - 0.5) * 0.3,
                vy: (Math.random() - 0.5) * 0.3,
                radius: Math.random() * 2 + 1,
                connections: []
            });
        }
        
        // Create connections
        for (let i = 0; i < this.nodes.length; i++) {
            for (let j = i + 1; j < this.nodes.length; j++) {
                const distance = this.getDistance(this.nodes[i], this.nodes[j]);
                if (distance < 120) {
                    this.connections.push({
                        nodeA: this.nodes[i],
                        nodeB: this.nodes[j],
                        distance: distance
                    });
                }
            }
        }
    }
    
    getDistance(nodeA, nodeB) {
        return Math.sqrt(Math.pow(nodeB.x - nodeA.x, 2) + Math.pow(nodeB.y - nodeA.y, 2));
    }
    
    animate() {
        this.ctx.clearRect(0, 0, this.canvas.width, this.canvas.height);
        
        // Update and draw nodes
        this.nodes.forEach(node => {
            // Move nodes
            node.x += node.vx;
            node.y += node.vy;
            
            // Bounce off edges
            if (node.x <= 0 || node.x >= this.canvas.width) node.vx *= -1;
            if (node.y <= 0 || node.y >= this.canvas.height) node.vy *= -1;
            
            // Mouse interaction
            const mouseDistance = Math.sqrt(
                Math.pow(this.mouse.x - node.x, 2) + Math.pow(this.mouse.y - node.y, 2)
            );
            
            if (mouseDistance < 80) {
                const force = (80 - mouseDistance) / 80;
                const angle = Math.atan2(node.y - this.mouse.y, node.x - this.mouse.x);
                node.x += Math.cos(angle) * force * 1.5;
                node.y += Math.sin(angle) * force * 1.5;
            }
            
            // Draw node
            this.ctx.beginPath();
            this.ctx.arc(node.x, node.y, node.radius, 0, Math.PI * 2);
            this.ctx.fillStyle = `rgba(0, 255, 255, ${0.7})`;
            this.ctx.fill();
        });
        
        // Draw connections
        this.connections.forEach(connection => {
            const distance = this.getDistance(connection.nodeA, connection.nodeB);
            const opacity = Math.max(0, (120 - distance) / 120) * 0.25;
            
            if (opacity > 0) {
                this.ctx.beginPath();
                this.ctx.moveTo(connection.nodeA.x, connection.nodeA.y);
                this.ctx.lineTo(connection.nodeB.x, connection.nodeB.y);
                this.ctx.strokeStyle = `rgba(0, 255, 255, ${opacity})`;
                this.ctx.lineWidth = 1;
                this.ctx.stroke();
            }
        });
        
        requestAnimationFrame(() => this.animate());
    }
}

// Initialize Neural Network
document.addEventListener('DOMContentLoaded', () => {
    const canvas = document.getElementById('neural-canvas');
    if (canvas) {
        new NeuralNetwork(canvas);
    }
});

// Smooth Scrolling Navigation with Progress Indicator
document.addEventListener('DOMContentLoaded', () => {
    const navItems = document.querySelectorAll('.nav-item');
    const sections = document.querySelectorAll('.section');
    const progressBar = document.querySelector('.scroll-progress .progress-bar');
    
    // Update scroll progress
    const updateScrollProgress = () => {
        const scrollTop = window.scrollY;
        const docHeight = document.documentElement.scrollHeight - window.innerHeight;
        const scrollPercent = (scrollTop / docHeight) * 100;
        if (progressBar) {
            progressBar.style.width = scrollPercent + '%';
        }
    };
    
    // Update active nav item on scroll
    const updateActiveNav = () => {
        let current = '';
        sections.forEach(section => {
            const sectionTop = section.offsetTop - 100;
            const sectionHeight = section.clientHeight;
            if (scrollY >= sectionTop - 200) {
                current = section.getAttribute('id');
            }
        });
        
        navItems.forEach(item => {
            item.classList.remove('active');
            if (item.getAttribute('data-section') === current) {
                item.classList.add('active');
            }
        });
        
        updateScrollProgress();
    };
    
    window.addEventListener('scroll', updateActiveNav);
    
    // Smooth scroll on nav click
    navItems.forEach(item => {
        item.addEventListener('click', (e) => {
            e.preventDefault();
            const targetId = item.getAttribute('href');
            const targetSection = document.querySelector(targetId);
            
            if (targetSection) {
                const offsetTop = targetSection.offsetTop - 80;
                window.scrollTo({
                    top: offsetTop,
                    behavior: 'smooth'
                });
            }
        });
    });
});

// Intersection Observer for Animations
const observerOptions = {
    threshold: 0.2,
    rootMargin: '0px 0px -50px 0px'
};

const observer = new IntersectionObserver((entries) => {
    entries.forEach(entry => {
        if (entry.isIntersecting) {
            // Trigger progress bar animations
            const progressFills = entry.target.querySelectorAll('[data-width]');
            progressFills.forEach(bar => {
                const width = bar.getAttribute('data-width');
                setTimeout(() => {
                    bar.style.width = width;
                }, 500);
            });
            
            // Trigger timeline animations
            const timelineItems = entry.target.querySelectorAll('.timeline-item');
            timelineItems.forEach((item, index) => {
                setTimeout(() => {
                    item.style.opacity = '1';
                    item.style.transform = 'translateY(0)';
                }, index * 150);
            });
            
            // Trigger section animations
            entry.target.style.opacity = '1';
            entry.target.style.transform = 'translateY(0)';
        }
    });
}, observerOptions);

// Observe elements
document.addEventListener('DOMContentLoaded', () => {
    const animatedElements = document.querySelectorAll(
        '.section, .timeline-item, .experience-card, .publication-card'
    );
    
    animatedElements.forEach(el => observer.observe(el));
});

// Abstract Tooltip (Improved)
document.addEventListener('DOMContentLoaded', () => {
    const paperTitles = document.querySelectorAll('[data-abstract]');
    const tooltip = document.getElementById('abstract-tooltip');
    const tooltipText = document.getElementById('tooltip-text');
    
    paperTitles.forEach(title => {
        title.addEventListener('mouseenter', (e) => {
            const abstract = title.getAttribute('data-abstract');
            tooltipText.textContent = abstract;
            tooltip.style.display = 'block';
            
            const rect = title.getBoundingClientRect();
            let left = rect.left;
            let top = rect.bottom + 20;
            
            // Adjust position if tooltip goes off screen
            const tooltipRect = tooltip.getBoundingClientRect();
            if (left + 400 > window.innerWidth) {
                left = window.innerWidth - 420;
            }
            if (top + tooltipRect.height > window.innerHeight) {
                top = rect.top - tooltipRect.height - 20;
            }
            
            tooltip.style.left = Math.max(20, left) + 'px';
            tooltip.style.top = Math.max(20, top) + 'px';
        });
        
        title.addEventListener('mouseleave', () => {
            tooltip.style.display = 'none';
        });
    });
    
    // Hide tooltip on scroll
    window.addEventListener('scroll', () => {
        tooltip.style.display = 'none';
    });
});

// Terminal Commands Animation
document.addEventListener('DOMContentLoaded', () => {
    const commands = document.querySelectorAll('.typing-text');
    
    commands.forEach((cmd, index) => {
        cmd.style.animationDelay = `${index * 0.8}s`;
    });
});

// Ensure smooth scrolling for all browsers
document.addEventListener('DOMContentLoaded', () => {
    // Polyfill for smooth scrolling in older browsers
    if (!CSS.supports('scroll-behavior', 'smooth')) {
        const links = document.querySelectorAll('a[href^="#"]');
        links.forEach(link => {
            link.addEventListener('click', (e) => {
                e.preventDefault();
                const targetId = link.getAttribute('href');
                const targetElement = document.querySelector(targetId);
                if (targetElement) {
                    targetElement.scrollIntoView({
                        behavior: 'smooth',
                        block: 'start'
                    });
                }
            });
        });
    }
});

// Performance optimization for animations
let ticking = false;

function updateScrollEffects() {
    // Update any scroll-based animations here
    ticking = false;
}

window.addEventListener('scroll', () => {
    if (!ticking) {
        requestAnimationFrame(updateScrollEffects);
        ticking = true;
    }
});

// Preload critical animations
document.addEventListener('DOMContentLoaded', () => {
    // Force a reflow to ensure CSS animations are ready
    document.body.offsetHeight;
    
    // Add loaded class to body for additional animations
    setTimeout(() => {
        document.body.classList.add('loaded');
    }, 100);
});
